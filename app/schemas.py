"""Public input schema for a voice call session.

Unlike a domain-specific agent, this service is generic: a caller fully
describes the agent's behaviour through `instructions` (free-form system
prompt) and hands over arbitrary call-specific `context` (a dict of
variables). The pipeline renders both into the LLM system prompt — that is
how the agent "makes the call with the given context in mind".
"""

from typing import Any, Optional

from pydantic import BaseModel, Field


class AgentConfig(BaseModel):
    """Everything that defines how the agent speaks and behaves on a call."""

    name: str = Field(default="Assistant", description="Name the agent gives on the call")
    company: Optional[str] = Field(
        default=None, description="Company/org the agent represents, if any"
    )
    role: Optional[str] = Field(
        default=None, description="Self-described role; informs tone and authority"
    )

    instructions: str = Field(
        ...,
        description=(
            "The agent's core behaviour — its system prompt. Describe the goal "
            "of the call, the persona, and how it should handle the conversation."
        ),
    )
    first_message: Optional[str] = Field(
        default=None,
        description=(
            "First line the agent speaks when the call connects. If omitted, a "
            "generic greeting built from the agent name/company is used."
        ),
    )

    # Optional per-call provider overrides (fall back to env defaults).
    voice_id: Optional[str] = Field(
        default=None, description="TTS voice id override for this call"
    )
    llm_model: Optional[str] = Field(
        default=None, description="LLM model override for this call"
    )


class CallContext(BaseModel):
    """Everything the voice pipeline needs to start a single call."""

    agent: AgentConfig = Field(..., description="Agent persona + instructions")
    context: dict[str, Any] = Field(
        default_factory=dict,
        description=(
            "Arbitrary call-specific context injected into the agent's system "
            "prompt — e.g. {'customer_name': 'John', 'appointment': '3pm Tue', "
            "'account_balance': '12500'}. Keys are surfaced to the agent verbatim."
        ),
    )
    metadata: dict[str, Any] = Field(
        default_factory=dict,
        description="Opaque passthrough returned with the call outcome; not shown to the agent.",
    )
