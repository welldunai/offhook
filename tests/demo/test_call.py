"""DemoCall: the plan → context mapping, the limits, response times and results."""

from typing import Any

from pipecat.frames.frames import EndFrame, LLMMessagesAppendFrame, TTSSpeakFrame

from app.demo.call import DemoCall, Limits, call_context, voice_config
from app.demo.config import DemoSettings

PLAN = {
    "agent": {"name": "Maya", "company": "Parcelly", "role": "customer care"},
    "person": "the customer",
    "brief": "Your parcel didn't come.",
    "goal": "Find a new delivery day.",
    "firstMessage": "Hi, this is Maya from Parcelly. Is now a good time?",
    "instructions": "Ask which day works, then any notes for the driver.",
    "assumptions": {"missed_date": "Monday"},
    "fields": [{"key": "new_day", "label": "New day"}, {"key": "driver_notes", "label": "Notes"}],
}
LIMITS = Limits(max_seconds=120, wrap_up_seconds=15, silence_seconds=20)


class Clock:
    def __init__(self) -> None:
        self.t = 100.0

    def __call__(self) -> float:
        return self.t


class FakeTask:
    def __init__(self) -> None:
        self.frames: list[Any] = []

    async def queue_frame(self, frame: Any) -> None:
        self.frames.append(frame)

    async def queue_frames(self, frames: list[Any]) -> None:
        self.frames.extend(frames)

    def has_finished(self) -> bool:
        return True


def started_call(clock: Clock) -> tuple[DemoCall, FakeTask, list[dict]]:
    """A call that is 'connected' at clock time 100, with a fake task and event sink."""
    call = DemoCall("sid", PLAN, LIMITS, voice_config(DemoSettings(_env_file=None)), clock=clock)
    task, events = FakeTask(), []
    call._task = task
    call._started = call._last_activity = clock()

    async def send(event: dict) -> None:
        events.append(event)

    call.send = send  # type: ignore[method-assign]
    return call, task, events


def test_call_context_spells_out_the_fields():
    ctx = call_context(PLAN)
    assert ctx.agent.name == "Maya" and ctx.agent.company == "Parcelly"
    assert ctx.agent.first_message == PLAN["firstMessage"]
    assert "new_day: New day" in ctx.agent.instructions
    assert "the customer" in ctx.agent.instructions
    assert ctx.context == {"missed_date": "Monday"}


def test_voice_config_uses_the_demo_keys():
    cfg = voice_config(DemoSettings(_env_file=None, DEEPGRAM_API_KEY="d", CARTESIA_API_KEY="c", CARTESIA_VOICE_ID="v", GROQ_API_KEY="g"))
    assert cfg.stt.secret("api_key") == "d"
    assert cfg.tts.secret("voice_id") == "v"
    assert cfg.llm.provider_name == "groq" and cfg.llm.setting("model") == "openai/gpt-oss-20b"


async def test_wraps_up_then_hangs_up_at_the_limit():
    clock = Clock()
    call, task, events = started_call(clock)
    call.on_speaking("user", True)  # someone's talking, so silence doesn't fire
    clock.t = 100 + 104
    assert await call.tick()
    assert task.frames == []
    clock.t = 100 + 105
    assert await call.tick()
    assert isinstance(task.frames[0], LLMMessagesAppendFrame) and task.frames[0].run_llm is False
    assert events == [{"type": "wrap_up"}]
    clock.t = 100 + 120
    assert not await call.tick()
    assert call.end_reason == "time_limit"
    assert isinstance(task.frames[1], TTSSpeakFrame) and isinstance(task.frames[-1], EndFrame)
    assert task.frames[2].message == {"type": "ended", "reason": "time_limit"}


async def test_silence_ends_the_call_only_when_nobody_is_talking():
    clock = Clock()
    call, _task, _ = started_call(clock)
    call.on_speaking("bot", True)
    clock.t += 30
    assert await call.tick()  # the agent is mid-sentence
    call.on_speaking("bot", False)
    clock.t += 19
    assert await call.tick()
    clock.t += 1
    assert not await call.tick()
    assert call.end_reason == "silence"


async def test_hang_up_happens_once():
    clock = Clock()
    call, task, _ = started_call(clock)
    await call.hang_up("silence", "Bye")
    await call.hang_up("time_limit", "Bye again")
    assert call.end_reason == "silence"
    assert sum(isinstance(f, EndFrame) for f in task.frames) == 1


def test_response_times_run_from_person_stopping_to_agent_starting():
    clock = Clock()
    call, _, _ = started_call(clock)
    call.on_speaking("user", True)
    clock.t += 2
    call.on_speaking("user", False)
    clock.t += 0.64
    call.on_speaking("bot", True)
    clock.t += 1
    call.on_speaking("bot", True)  # no new user turn: not counted
    assert call.latency_ms == [640]


def test_results_keep_only_plan_fields_and_cap_lengths():
    clock = Clock()
    call, _, _ = started_call(clock)
    call.transcript = [
        {"role": "assistant", "text": PLAN["firstMessage"], "t": 0.0},
        {"role": "user", "text": "Thursday works", "t": 4.25},
        {"role": "user", "text": "  ", "t": 5.0},
        {"role": "assistant", "text": "x" * 3000, "t": 6.0},
    ]
    call.data = {"new_day": "Thursday", "driver_notes": "n" * 900, "made_up": "nope"}
    call.summary = "Rebooked for Thursday."
    call.end_reason = "agent_ended"
    call.latency_ms = [640]
    clock.t += 42
    r = call.results()
    assert r["session_id"] == "sid" and r["status"] == "completed" and r["end_reason"] == "agent_ended"
    assert r["duration_seconds"] == 42
    assert r["outcome"] == {"new_day": "Thursday", "driver_notes": "n" * 500}
    assert [t["who"] for t in r["transcript"]] == ["agent", "person", "agent"]
    assert r["transcript"][1]["at_ms"] == 4250
    assert len(r["transcript"][2]["text"]) == 2000
    assert r["summary"] == "Rebooked for Thursday." and r["latency"] == [640]


def test_results_for_a_call_that_never_connected():
    call = DemoCall("sid", PLAN, LIMITS, voice_config(DemoSettings(_env_file=None)))
    r = call.results()
    assert (r["duration_seconds"], r["end_reason"], r["transcript"]) == (0.0, "error", [])


async def test_watcher_streams_turns_and_results_once_and_tracks_speaking():
    from pipecat.frames.frames import (
        BotStartedSpeakingFrame,
        FunctionCallInProgressFrame,
        UserStoppedSpeakingFrame,
    )
    from pipecat.observers.base_observer import FramePushed
    from pipecat.processors.frame_processor import FrameDirection

    from app.demo.call import _Watcher

    clock = Clock()
    call, _, events = started_call(clock)
    call.transcript = [{"role": "assistant", "text": "Hi", "t": 0.0}]
    watcher = _Watcher(call)
    push = lambda f: watcher.on_push_frame(FramePushed(None, None, f, FrameDirection.DOWNSTREAM, 0))  # noqa: E731

    stopped = UserStoppedSpeakingFrame()
    await push(stopped)
    await push(stopped)  # the same frame seen at another processor boundary
    call.transcript.append({"role": "user", "text": "Thursday", "t": 2.0})
    clock.t += 0.5
    await push(BotStartedSpeakingFrame())
    for _ in range(2):  # Pipecat pushes the same call as two frames
        await push(FunctionCallInProgressFrame(function_name="record_result", tool_call_id="1", arguments={"key": "new_day", "value": "Thursday"}))
    await push(FunctionCallInProgressFrame(function_name="end_call", tool_call_id="2", arguments={"summary": "done"}))

    assert events == [
        {"type": "transcript", "who": "agent", "text": "Hi"},
        {"type": "transcript", "who": "person", "text": "Thursday"},
        {"type": "result", "key": "new_day", "value": "Thursday"},
    ]
    assert call.latency_ms == [500]
