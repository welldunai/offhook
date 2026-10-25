"""One demo call: Offhook's pipeline plus the demo's limits and live events.

The pipeline itself is the product's (``app.pipeline.build_pipeline_task``):
same prompts, tools, STT/LLM/TTS and transcript capture as a real phone call.
This module adds only what the demo needs around it:

  * the plan from the Worker turned into a ``CallContext``;
  * live events to the browser (transcript turns, recorded results);
  * the time limit (wrap-up nudge, then a polite hang-up), and the silence cutoff;
  * per-turn response time (person stops talking → agent starts talking);
  * the results body the Worker stores for the results page.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Any, Callable

from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    EndFrame,
    ErrorFrame,
    FunctionCallInProgressFrame,
    LLMMessagesAppendFrame,
    OutputTransportMessageFrame,
    OutputTransportMessageUrgentFrame,
    TTSSpeakFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.observers.base_observer import BaseObserver, FramePushed
from pipecat.pipeline.runner import PipelineRunner

from app.config import ResolvedCreds, VoiceConfig
from app.demo.config import DemoSettings
from app.logger import logger
from app.pipeline import build_pipeline_task
from app.schemas import AgentConfig, CallContext

WRAP_UP_NOTE = (
    "Time is almost up on this call. Wrap up in your next reply: thank them, record "
    "anything you've learned with record_result, and call end_call."
)
TIME_UP_GOODBYE = "I'm sorry, we're out of time for this call. Thanks so much for talking with me. Goodbye!"
SILENCE_GOODBYE = "It sounds like you've stepped away, so I'll let you go. Goodbye!"
PROVIDER_ERROR = "The call couldn't connect to its speech services. Try again in a minute."
#: Errors tolerated once the agent has spoken; one is enough before that.
MAX_ERRORS = 3
#: Seconds after a hang-up starts before the call is cut regardless.
HARD_STOP_SECONDS = 10


@dataclass(frozen=True)
class Limits:
    """Timings the Worker hands over with the plan."""

    max_seconds: int
    wrap_up_seconds: int
    silence_seconds: int


def call_context(plan: dict[str, Any]) -> CallContext:
    """Turn a Worker plan into the pipeline's ``CallContext``.

    The fields to record are spelled out with their exact keys, so the agent's
    ``record_result`` calls line up with the results page.

    Args:
        plan: The plan from ``/internal/claim`` (camelCase, as the Worker stores it).

    Returns:
        The call context.
    """
    fields = "\n".join(f"  - {f['key']}: {f['label']}" for f in plan["fields"])
    instructions = (
        f"{plan['instructions'].strip()}\n\n"
        f"You are speaking with {plan['person']}. Your goal: {plan['goal']}\n"
        f"Record each of these with record_result, using exactly these keys:\n{fields}"
    )
    agent = plan["agent"]
    return CallContext(
        agent=AgentConfig(
            name=agent["name"],
            company=agent.get("company"),
            role=agent.get("role"),
            instructions=instructions,
            first_message=plan["firstMessage"],
        ),
        context=dict(plan.get("assumptions") or {}),
    )


def voice_config(settings: DemoSettings) -> VoiceConfig:
    """Build the call's provider config from the server's own keys.

    Args:
        settings: The demo settings.

    Returns:
        A ``VoiceConfig`` for Deepgram, Cartesia and Groq.
    """
    return VoiceConfig(
        stt=ResolvedCreds("deepgram", {"api_key": settings.deepgram_api_key}),
        tts=ResolvedCreds(
            "cartesia", {"api_key": settings.cartesia_api_key, "voice_id": settings.cartesia_voice_id}
        ),
        llm=ResolvedCreds(
            "groq",
            {"api_key": settings.groq_api_key},
            {"model": settings.llm_model, "reasoning_effort": settings.llm_reasoning_effort or None},
        ),
        debug_logging=False,
    )


class DemoCall:
    """Runs one call and remembers what happened."""

    def __init__(
        self,
        session_id: str,
        plan: dict[str, Any],
        limits: Limits,
        cfg: VoiceConfig,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        """
        Args:
            session_id: The Worker's session.
            plan: The plan from the claim.
            limits: Call length, wrap-up and silence timings.
            cfg: Provider config (see ``voice_config``).
            clock: Monotonic seconds; tests pass a fake.
        """
        self.session_id = session_id
        self.plan = plan
        self.limits = limits
        self.cfg = cfg
        self.clock = clock

        self.end_reason: str | None = None
        self.failed = False
        self.latency_ms: list[int] = []
        self.transcript: list[dict[str, Any]] = []  # the outcome's list, once running
        self.data: dict[str, Any] = {}
        self.summary: str | None = None

        self._started: float | None = None
        self._ended: float | None = None
        self._last_activity = 0.0
        self._user_speaking = False
        self._bot_speaking = False
        self._user_stopped_at: float | None = None
        self._wrapped = False
        self._errors = 0
        self._agent_spoke = False
        self._task: Any = None
        self._transport: Any = None

    # --- running ------------------------------------------------------------

    async def run(self, transport: Any) -> None:
        """Run the call until either side hangs up or a limit ends it.

        Args:
            transport: A connected Pipecat transport (the browser WebSocket).
        """
        ctx = call_context(self.plan)
        task, outcome, _llm, _ = build_pipeline_task(transport, ctx, self.cfg)
        self._task, self._transport = task, transport
        self.transcript = outcome.transcript
        self.data = outcome.data
        opener = ctx.agent.first_message or ""
        self.transcript.append({"role": "assistant", "text": opener, "t": 0.0})
        task.add_observer(_Watcher(self))

        timers: asyncio.Task | None = None

        @transport.event_handler("on_client_connected")  # type: ignore[misc]
        async def _connected(_t: Any, _c: Any) -> None:
            nonlocal timers
            self._started = self._last_activity = self.clock()
            await task.queue_frames([TTSSpeakFrame(opener)])
            timers = asyncio.create_task(self._watch_time())

        @transport.event_handler("on_client_disconnected")  # type: ignore[misc]
        async def _disconnected(_t: Any, _c: Any) -> None:
            if self.end_reason is None:
                self.end_reason = "hung_up"
            await task.cancel()

        try:
            await PipelineRunner(handle_sigint=False).run(task)
        except Exception:
            logger.exception(f"[demo] call {self.session_id} failed")
            self.failed = True
            self.end_reason = "error"
        finally:
            self._ended = self.clock()
            if timers is not None:
                timers.cancel()
        self.summary = outcome.summary
        if self.end_reason is None:
            self.end_reason = "agent_ended" if outcome.ended_by_agent else "disconnected"
        logger.info(f"[demo] call {self.session_id} ended: {self.end_reason}")

    async def hang_up(self, reason: str, goodbye: str) -> None:
        """End the call politely: say goodbye, tell the browser why, then stop.

        Args:
            reason: The end reason reported to the Worker.
            goodbye: What the agent says last.
        """
        if self.end_reason is not None or self._task is None:
            return
        self.end_reason = reason
        self.transcript.append({"role": "assistant", "text": goodbye, "t": self._elapsed()})
        await self._task.queue_frames(
            [TTSSpeakFrame(goodbye), OutputTransportMessageFrame(message={"type": "ended", "reason": reason}), EndFrame()]
        )

        async def _hard_stop() -> None:
            await asyncio.sleep(HARD_STOP_SECONDS)
            if not self._task.has_finished():
                await self._task.cancel()

        asyncio.create_task(_hard_stop())

    async def tick(self) -> bool:
        """Apply the time and silence limits once.

        Returns:
            True while the call should keep being watched.
        """
        if self._started is None or self.end_reason is not None:
            return self.end_reason is None
        elapsed = self._elapsed()
        if not self._wrapped and elapsed >= self.limits.max_seconds - self.limits.wrap_up_seconds:
            self._wrapped = True
            await self._task.queue_frame(
                LLMMessagesAppendFrame(messages=[{"role": "system", "content": WRAP_UP_NOTE}], run_llm=False)
            )
            await self.send({"type": "wrap_up"})
        if elapsed >= self.limits.max_seconds:
            await self.hang_up("time_limit", TIME_UP_GOODBYE)
            return False
        quiet = not self._user_speaking and not self._bot_speaking
        if quiet and self.clock() - self._last_activity >= self.limits.silence_seconds:
            await self.hang_up("silence", SILENCE_GOODBYE)
            return False
        return True


    async def _watch_time(self) -> None:
        """Check the limits twice a second until the call ends."""
        while await self.tick():
            await asyncio.sleep(0.5)

    async def send(self, event: dict[str, Any]) -> None:
        """Send a JSON event to the browser, skipping the pipeline queue.

        Args:
            event: The event (see ``app.demo.serializer``).
        """
        if self._transport is not None:
            await self._transport.output().send_message(OutputTransportMessageUrgentFrame(message=event))

    # --- what the watcher reports ---------------------------------------------

    def on_speaking(self, who: str, speaking: bool) -> None:
        """Track who is talking, for silence and response times.

        Args:
            who: "user" or "bot".
            speaking: Whether they just started (True) or stopped (False).
        """
        now = self.clock()
        self._last_activity = now
        if who == "user":
            self._user_speaking = speaking
            if not speaking:
                self._user_stopped_at = now
        else:
            self._bot_speaking = speaking
            self._agent_spoke = self._agent_spoke or speaking
            if speaking and self._user_stopped_at is not None:
                self.latency_ms.append(round((now - self._user_stopped_at) * 1000))
                self._user_stopped_at = None

    async def on_error(self, error: str) -> None:
        """A pipeline service reported an error (e.g. Deepgram or Cartesia unreachable).

        Before the agent has said anything, the visitor would only hear silence,
        so one error fails the call; after that, a few are tolerated.

        Args:
            error: The error text, for the log only.
        """
        self._errors += 1
        logger.warning(f"[demo] call {self.session_id} error {self._errors}: {error}")
        if self.end_reason is not None or (self._agent_spoke and self._errors < MAX_ERRORS):
            return
        self.failed = True
        self.end_reason = "error"
        await self.send({"type": "error", "error": "provider_error", "message": PROVIDER_ERROR})
        if self._task is not None:
            await self._task.cancel()

    # --- results --------------------------------------------------------------

    def results(self) -> dict[str, Any]:
        """Return the body for the Worker's ``/internal/results``.

        Only the plan's fields are reported, so stray keys the model invents
        don't reach the results page. Lengths are capped to the Worker's limits.
        """
        keys = [f["key"] for f in self.plan.get("fields", [])]
        outcome = {k: _value(self.data[k]) for k in keys if k in self.data}
        transcript = [
            {
                "who": "agent" if turn["role"] == "assistant" else "person",
                "text": str(turn["text"])[:2000],
                "at_ms": max(0, round(float(turn.get("t", 0)) * 1000)),
            }
            for turn in self.transcript
            if str(turn.get("text", "")).strip()
        ][:300]
        duration = 0.0
        if self._started is not None:
            duration = max(0.0, (self._ended or self.clock()) - self._started)
        return {
            "session_id": self.session_id,
            "status": "failed" if self.failed else "completed",
            "end_reason": self.end_reason or "error",
            "duration_seconds": round(duration, 1),
            "transcript": transcript,
            "outcome": outcome,
            "summary": (self.summary or "")[:1000] or None,
            "latency": self.latency_ms[:300],
        }

    def _elapsed(self) -> float:
        """Seconds since the browser connected (0 before that)."""
        return 0.0 if self._started is None else self.clock() - self._started


def _value(v: Any) -> Any:
    """Return a recorded value the Worker accepts: a scalar, strings capped at 500."""
    if v is None or isinstance(v, (bool, int, float)):
        return v
    return str(v)[:500]


class _Watcher(BaseObserver):
    """Feeds the call what happens in the pipeline, and streams it to the browser.

    An observer sees each frame at every processor boundary, so frames are
    de-duplicated by id.
    """

    def __init__(self, call: DemoCall) -> None:
        super().__init__()
        self._call = call
        self._seen: set[int] = set()
        self._sent = 0  # transcript turns already streamed
        self._results_sent: set[str] = set()  # tool call ids already streamed

    async def on_push_frame(self, data: FramePushed) -> None:
        """Handle one frame push. See the class docstring."""
        frame = data.frame
        fid = getattr(frame, "id", None)
        if fid is not None and fid not in self._seen:
            self._seen.add(fid)
            if isinstance(frame, UserStartedSpeakingFrame):
                self._call.on_speaking("user", True)
            elif isinstance(frame, UserStoppedSpeakingFrame):
                self._call.on_speaking("user", False)
            elif isinstance(frame, BotStartedSpeakingFrame):
                self._call.on_speaking("bot", True)
            elif isinstance(frame, BotStoppedSpeakingFrame):
                self._call.on_speaking("bot", False)
            elif isinstance(frame, ErrorFrame):
                await self._call.on_error(str(frame.error))
            elif (
                isinstance(frame, FunctionCallInProgressFrame)
                and frame.function_name == "record_result"
                and frame.tool_call_id not in self._results_sent  # pushed both ways, as two frames
            ):
                self._results_sent.add(frame.tool_call_id)
                args = frame.arguments or {}
                await self._call.send({"type": "result", "key": str(args.get("key", "")), "value": _value(args.get("value"))})
            elif (
                isinstance(frame, FunctionCallInProgressFrame)
                and frame.function_name == "end_call"
                and frame.tool_call_id not in self._results_sent
            ):
                # The agent is hanging up; the socket closes once its goodbye has played.
                self._results_sent.add(frame.tool_call_id)
                await self._call.send({"type": "ended", "reason": "agent_ended"})

        # TranscriptCollector appends turns to the outcome; stream any new ones.
        turns = self._call.transcript
        while self._sent < len(turns):
            turn = turns[self._sent]
            self._sent += 1
            who = "agent" if turn["role"] == "assistant" else "person"
            await self._call.send({"type": "transcript", "who": who, "text": turn["text"]})
