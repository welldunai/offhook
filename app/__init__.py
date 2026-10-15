"""offhook — a multi-tenant Pipecat voice-calling backend.

Public surface:
    CallContext, AgentConfig        — the per-call agent + context shape
    CallOutcome                     — what a call returns
    run_call(transport, ctx, cfg)   — top-level per-call entrypoint
    VoiceConfig, ResolvedCreds      — resolved per-tenant credentials for a call
"""

from app.config import ResolvedCreds, VoiceConfig
from app.runner import run_call
from app.schemas import AgentConfig, CallContext
from app.tools import CallOutcome

__all__ = [
    "AgentConfig",
    "CallContext",
    "CallOutcome",
    "ResolvedCreds",
    "VoiceConfig",
    "run_call",
]
