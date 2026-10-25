"""The demo's calls: a plan from the Worker run as a browser call.

The call machinery is shared with the dashboard's test calls (``app.browser.call``);
this module only turns the demo Worker's plan into an agent, and builds provider
config from the voice server's own keys.
"""

from __future__ import annotations

from typing import Any, Callable
import time

from app.browser.call import BrowserCall, Limits
from app.config import ResolvedCreds, VoiceConfig
from app.demo.config import DemoSettings
from app.schemas import AgentConfig, CallContext

__all__ = ["DemoCall", "Limits", "call_context", "voice_config"]


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


class DemoCall(BrowserCall):
    """A browser call for one demo session, reporting only the plan's fields."""

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
        super().__init__(
            session_id, call_context(plan), limits, cfg,
            fields=[f["key"] for f in plan.get("fields", [])], clock=clock,
        )
        self.plan = plan
