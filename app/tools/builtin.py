"""Built-in, domain-agnostic tools.

  * ``record_result`` — capture any structured outcome as a key/value pair.
  * ``end_call``      — hang up once the conversation has naturally concluded.

These cover the generic case. Domain-specific tools (book_appointment,
transfer_to_human, ...) are added the same way: subclass ``Tool`` and register
it; nothing else changes.
"""

from __future__ import annotations

from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.frames.frames import EndFrame, FunctionCallResultProperties
from pipecat.services.llm_service import FunctionCallParams

from app.logger import logger
from app.tools import tool_registry
from app.tools.base import Tool, ToolContext, ToolHandler


@tool_registry.register("record_result")
class RecordResultTool(Tool):
    schema = FunctionSchema(
        name="record_result",
        description=(
            "Capture a structured outcome of the call as a key and value. Call "
            "this whenever the conversation establishes a concrete fact worth "
            "keeping (e.g. key='appointment_confirmed', value='yes'; "
            "key='callback_time', value='Tuesday 3pm'). Call it multiple times "
            "for multiple facts."
        ),
        properties={
            "key": {"type": "string", "description": "Snake_case name of the fact"},
            "value": {"type": "string", "description": "The value, as a short string"},
        },
        required=["key", "value"],
    )

    def make_handler(self, ctx: ToolContext) -> ToolHandler:
        async def handler(params: FunctionCallParams) -> None:
            key = params.arguments.get("key")
            value = params.arguments.get("value")
            # Models sometimes "reserve" a field with a placeholder before asking.
            placeholder = value is None or str(value).strip() in {"", "?"}
            if key is not None and not placeholder:
                ctx.outcome.data[str(key)] = value
            logger.info(f"[voice] result recorded: {key}={value}")
            # By default the LLM runs again after every tool result. If the agent
            # already spoke this turn, that second run makes it talk again while
            # the person is silent ("Thanks for that. How about…"). Only let it
            # continue when it recorded before saying anything.
            spoke = bool(ctx.agent_said().strip())
            await params.result_callback(
                {"acknowledged": True}, properties=FunctionCallResultProperties(run_llm=not spoke)
            )

        return handler


@tool_registry.register("end_call")
class EndCallTool(Tool):
    schema = FunctionSchema(
        name="end_call",
        description=(
            "Hang up. Only call this after the other person has replied to your "
            "last message and the conversation is over: you have said goodbye and "
            "they have nothing more to add. Never call it in the same turn as a "
            "question (for example 'Anything else?'); ask, wait for the answer, "
            "say goodbye, then call it. Provide a one-line summary of what happened."
        ),
        properties={
            "summary": {"type": "string", "description": "One-line outcome summary"},
        },
        required=["summary"],
    )

    def make_handler(self, ctx: ToolContext) -> ToolHandler:
        async def handler(params: FunctionCallParams) -> None:
            # Models often say "Anything else?" and hang up in the same breath.
            # Keep the line open until the person has answered; run_llm=False so
            # the agent doesn't say anything new while it waits.
            if ctx.agent_said().rstrip().endswith("?"):
                logger.info("[voice] end_call refused: the agent just asked a question")
                await params.result_callback(
                    {
                        "ended": False,
                        "reason": "You just asked them a question, so the call is still open. "
                        "Wait for their answer; when the conversation is over, say goodbye "
                        "and call end_call again.",
                    },
                    properties=FunctionCallResultProperties(run_llm=False),
                )
                return
            ctx.outcome.summary = params.arguments.get("summary")
            ctx.outcome.ended_by_agent = True
            logger.info(f"[voice] end_call: {ctx.outcome.summary}")
            await params.result_callback({"acknowledged": True})
            # Queued (not pushed) so any in-flight goodbye TTS plays first; the
            # EndFrame propagates through after pending frames drain.
            await ctx.task.queue_frame(EndFrame())

        return handler
