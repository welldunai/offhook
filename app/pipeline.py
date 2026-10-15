"""Pipeline assembly — STT → LLM (with tools) → TTS, wrapped around a transport.

This module owns only Pipecat's *pipeline shape*. Everything pluggable is
delegated:

  * which STT/TTS/LLM service        → ``app.providers.build_*`` (registry)
  * which tools the agent can call   → ``app.tools`` (registry)
  * the system prompt + opener text  → ``app.prompts``
  * the transport (audio in/out)     → passed in by the caller

So this file rarely changes when you add a provider, tool, or carrier.
"""

from typing import Any

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)

from app.config import VoiceConfig
from app.prompts import build_opener, build_system_prompt
from app.providers import build_llm, build_stt, build_tts
from app.schemas import CallContext
from app.tools import CallOutcome, ToolContext, build_tools_schema, register_handlers


def build_pipeline_task(
    transport: Any,
    ctx: CallContext,
    cfg: VoiceConfig,
    *,
    enable_rtvi: bool = False,
    recorder: Any = None,
    custom_tools: list | None = None,
) -> tuple[PipelineTask, CallOutcome, Any, Any]:
    """Build the Pipecat task for one call.

    ``cfg`` already carries resolved per-tenant credentials (and any per-call
    voice/model overrides merged into each leg's settings — see
    ``app/tenancy/resolve.py``).

    ``enable_rtvi`` inserts an ``RTVIProcessor`` + ``RTVIObserver`` so the
    pipeline streams live events (transcripts, speaking state, tool calls) to the
    client over the transport's data channel. Only used for the browser WebRTC
    path — the telephony transports carry no such channel.

    Returns:
        ``(task, outcome, llm)`` — ``outcome`` accumulates tool results during
        the call; ``llm`` is returned so callers can attach extra handlers.
    """
    system_prompt = build_system_prompt(ctx)

    stt = build_stt(cfg.stt)
    tts = build_tts(cfg.tts)
    llm = build_llm(cfg.llm)

    outcome = CallOutcome()

    # Pre-load the deterministic opener as the first assistant turn so the LLM
    # has continuity once the other party replies — without it, the LLM would
    # think nothing has been said yet and re-greet from scratch.
    context = LLMContext(
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "assistant", "content": build_opener(ctx)},
        ],
        tools=build_tools_schema(custom_tools=custom_tools),
    )
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer()),
    )

    # Capture the conversation into the outcome (persisted as the transcript).
    from app.transcript import TranscriptCollector

    observers = [TranscriptCollector(outcome)]

    # Pipecat's logging observers print the rich per-stage view to the server
    # console (loguru DEBUG): TTFB + processing time per processor, LLM token
    # usage, TTS character usage, user→bot response latency, and live
    # transcripts. The MetricsFrames they consume are produced because
    # enable_metrics/enable_usage_metrics are on below.
    if cfg.debug_logging:
        from pipecat.observers.loggers.llm_log_observer import LLMLogObserver
        from pipecat.observers.loggers.metrics_log_observer import MetricsLogObserver
        from pipecat.observers.loggers.transcription_log_observer import (
            TranscriptionLogObserver,
        )
        from pipecat.observers.loggers.user_bot_latency_log_observer import (
            UserBotLatencyLogObserver,
        )

        observers += [
            MetricsLogObserver(),
            UserBotLatencyLogObserver(),
            TranscriptionLogObserver(),
            LLMLogObserver(),
        ]

    # Optional live-events processor. Placed right after transport.input() so
    # the urgent event frames it emits travel downstream all the way to
    # transport.output() (and out the data channel to the client).
    rtvi = None
    if enable_rtvi:
        from pipecat.processors.frameworks.rtvi import (
            RTVIObserver,
            RTVIObserverParams,
            RTVIProcessor,
        )

        rtvi = RTVIProcessor()
        # Send only the spoken (TTS-aligned) text as the bot transcript. With
        # bot_llm_enabled also on, the client receives the LLM's generated text
        # AND the word-by-word TTS text and renders both — the duplicated /
        # stuttering transcript. One stream = one clean transcript.
        observers.append(
            RTVIObserver(rtvi, params=RTVIObserverParams(bot_llm_enabled=False))
        )

    # Safety net: strip any tool-call syntax the LLM verbalizes before it reaches TTS.
    from app.textfilter import ToolCallTextFilter

    stages = [transport.input()]
    if rtvi is not None:
        stages.append(rtvi)
    stages += [stt, user_aggregator, llm, ToolCallTextFilter(), tts, transport.output(), assistant_aggregator]

    # Optional audio recording: capture the mixed (user + bot) call audio. Placed
    # last so it sees both the input and the synthesized output audio.
    audiobuffer = None
    if recorder is not None:
        from pipecat.processors.audio.audio_buffer_processor import AudioBufferProcessor

        audiobuffer = AudioBufferProcessor(num_channels=1)
        stages.append(audiobuffer)

        @audiobuffer.event_handler("on_audio_data")  # type: ignore[misc]
        async def _on_audio_data(_buf: Any, audio: bytes, sample_rate: int, num_channels: int) -> None:
            recorder.audio = audio
            recorder.sample_rate = sample_rate
            recorder.num_channels = num_channels

    task = PipelineTask(
        Pipeline(stages),
        params=PipelineParams(
            enable_metrics=True,
            enable_usage_metrics=True,
        ),
        observers=observers,
    )
    register_handlers(llm, ToolContext(outcome=outcome, task=task), custom_tools=custom_tools)
    return task, outcome, llm, audiobuffer
