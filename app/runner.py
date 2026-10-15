"""Top-level entrypoint that runs a voice call against a pre-built transport.

Transport choice (browser WebRTC, Plivo telephony, etc.) is the caller's
job — see `app/transport.py`. This file owns the per-call lifecycle:
opener, end-of-call frame, runner.
"""

from typing import Any

from pipecat.frames.frames import EndFrame, TTSSpeakFrame
from pipecat.pipeline.runner import PipelineRunner

from app.config import VoiceConfig
from app.logger import logger
from app.pipeline import build_pipeline_task
from app.prompts import build_opener
from app.schemas import CallContext
from app.tools import CallOutcome


async def run_call(
    transport: Any,
    ctx: CallContext,
    cfg: VoiceConfig,
    *,
    enable_rtvi: bool = False,
    recorder: Any = None,
    custom_tools: Any = None,
) -> CallOutcome:
    """Run one voice call end-to-end and return the outcome.

    The coroutine resolves when the client disconnects or the agent calls
    `end_call`. Any structured results captured during the call are returned
    in the `CallOutcome`. ``cfg`` carries the tenant's resolved credentials
    (built by the route). ``enable_rtvi`` streams live events to the client
    (browser WebRTC path only). If a ``recorder`` is given, the mixed call audio
    is captured into it. ``custom_tools`` is the tenant's resolved HTTP tools the
    LLM may call during the conversation.
    """
    task, outcome, _llm, audiobuffer = build_pipeline_task(
        transport, ctx, cfg, enable_rtvi=enable_rtvi, recorder=recorder,
        custom_tools=custom_tools,
    )

    @transport.event_handler("on_client_connected")  # type: ignore[misc]
    async def on_client_connected(_transport: Any, _client: Any) -> None:
        logger.info(f"[voice] client connected, agent={ctx.agent.name}")
        if audiobuffer is not None:
            await audiobuffer.start_recording()
        # Speak the deterministic opener and stop. The LLM is NOT kicked here
        # — it runs only when the other party's first turn arrives via STT, so
        # we don't get two consecutive utterances at call start. The opener
        # is also pre-loaded into the LLM context (see build_pipeline_task)
        # so the LLM has continuity once it does start responding.
        await task.queue_frames([TTSSpeakFrame(build_opener(ctx))])

    @transport.event_handler("on_client_disconnected")  # type: ignore[misc]
    async def on_client_disconnected(_transport: Any, _client: Any) -> None:
        logger.info(f"[voice] client disconnected, agent={ctx.agent.name}")
        await task.queue_frame(EndFrame())

    runner = PipelineRunner(handle_sigint=False)
    await runner.run(task)
    logger.info(f"[voice] call finished, outcome: {outcome.model_dump()}")
    return outcome
