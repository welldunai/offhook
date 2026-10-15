"""Built-in, domain-agnostic tools.

  * ``record_result`` — capture any structured outcome as a key/value pair.
  * ``end_call``      — hang up once the conversation has naturally concluded.

These cover the generic case. Domain-specific tools (book_appointment,
transfer_to_human, ...) are added the same way: subclass ``Tool`` and register
it; nothing else changes.
"""

from __future__ import annotations

from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.frames.frames import EndFrame
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
            if key is not None:
                ctx.outcome.data[str(key)] = value
            logger.info(f"[voice] result recorded: {key}={value}")
            await params.result_callback({"acknowledged": True})

        return handler


@tool_registry.register("end_call")
class EndCallTool(Tool):
    schema = FunctionSchema(
        name="end_call",
        description=(
            "Call when the conversation has reached a natural conclusion and you "
            "are ready to hang up. Provide a one-line summary of what happened."
        ),
        properties={
            "summary": {"type": "string", "description": "One-line outcome summary"},
        },
        required=["summary"],
    )

    def make_handler(self, ctx: ToolContext) -> ToolHandler:
        async def handler(params: FunctionCallParams) -> None:
            ctx.outcome.summary = params.arguments.get("summary")
            ctx.outcome.ended_by_agent = True
            logger.info(f"[voice] end_call: {ctx.outcome.summary}")
            await params.result_callback({"acknowledged": True})
            # Queued (not pushed) so any in-flight goodbye TTS plays first; the
            # EndFrame propagates through after pending frames drain.
            await ctx.task.queue_frame(EndFrame())

        return handler
