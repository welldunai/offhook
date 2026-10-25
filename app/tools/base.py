"""Tool abstraction + the per-call outcome accumulator.

A *tool* is an LLM-callable function the agent can invoke mid-conversation. Each
tool bundles two things:

  * ``schema``        — the Pipecat ``FunctionSchema`` the LLM sees.
  * ``make_handler``  — a factory that, given a :class:`ToolContext` for one
                        call, returns the async handler bound to that call's
                        state. Tools are stateless and shared; all per-call
                        state lives in the ``ToolContext``.

Splitting "definition" (schema) from "binding" (make_handler) is what lets the
same tool be reused across every call while still mutating that call's private
:class:`CallOutcome`.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from pydantic import BaseModel, Field

from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.frames.frames import Frame, InterruptionFrame, LLMTextFrame, UserStartedSpeakingFrame
from pipecat.pipeline.task import PipelineTask
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.llm_service import FunctionCallParams

#: A bound tool handler: receives the LLM's call params, does its work, and
#: must invoke ``params.result_callback(...)`` to return a result to the model.
ToolHandler = Callable[[FunctionCallParams], Awaitable[None]]


class CallOutcome(BaseModel):
    """In-memory aggregate of what the agent produced during a single call.

    Returned by ``run_call`` and logged on hang-up. Tools mutate it via the
    :class:`ToolContext`. Add fields here as you add tools that need to report
    richer results.
    """

    data: dict[str, Any] = Field(
        default_factory=dict,
        description="Structured key/values the agent captured via record_result.",
    )
    summary: str | None = Field(default=None)
    ended_by_agent: bool = Field(default=False)
    transcript: list[dict[str, Any]] = Field(
        default_factory=list,
        description="Conversation turns: [{role, text, t}] captured during the call.",
    )


@dataclass
class ToolContext:
    """Per-call state handed to every tool handler.

    ``outcome`` is the mutable result accumulator. ``task`` is the running
    pipeline — tools need it to inject frames (e.g. ``end_call`` queues an
    ``EndFrame`` to hang up). ``agent_said`` returns what the agent has said
    since the other person last started talking (see :class:`AgentTurnText`).
    """

    outcome: CallOutcome
    task: PipelineTask
    agent_said: Callable[[], str] = lambda: ""


class AgentTurnText(FrameProcessor):
    """Remembers what the agent has said since the other person last spoke.

    Sits right after the LLM. ``end_call`` uses it to refuse hanging up straight
    after a question ("Anything else?") that the person hasn't answered yet.
    """

    def __init__(self) -> None:
        super().__init__()
        self.text = ""

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        """Track the agent's text; reset when the person starts talking.

        Args:
            frame: Any frame passing through.
            direction: Its direction; frames are always passed on unchanged.
        """
        await super().process_frame(frame, direction)
        if isinstance(frame, (UserStartedSpeakingFrame, InterruptionFrame)):
            self.text = ""
        elif isinstance(frame, LLMTextFrame):
            self.text += frame.text
        await self.push_frame(frame, direction)


class Tool(abc.ABC):
    """Base class for an agent tool."""

    #: The LLM-visible definition. ``schema.name`` is the function name the
    #: model calls and the registry key it is exposed under.
    schema: FunctionSchema

    @abc.abstractmethod
    def make_handler(self, ctx: ToolContext) -> ToolHandler:
        """Return an async handler bound to one call's :class:`ToolContext`."""
