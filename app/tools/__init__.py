"""Agent tools — LLM-callable functions, pluggable via a registry.

The pipeline asks this package for two things per call:

  * ``build_tools_schema(names)``  — the ``ToolsSchema`` advertised to the LLM.
  * ``register_handlers(llm, ctx, names)`` — binds each tool's handler to the
    call's :class:`~app.tools.base.ToolContext` and registers it on the LLM.

``names`` defaults to :data:`DEFAULT_TOOLS` but can be passed per call, which is
how an agent gets a custom tool set without touching the pipeline.

Adding a tool:
    1. Subclass :class:`~app.tools.base.Tool` in ``app/tools/builtin.py`` (or a
       new module) and decorate it with ``@tool_registry.register("<name>")``.
    2. Add ``"<name>"`` to ``DEFAULT_TOOLS`` (or pass it per call).
"""

from app.registry import Registry
from app.tools.base import CallOutcome, Tool, ToolContext, ToolHandler

#: name → Tool subclass. Populated by the modules imported below.
tool_registry: Registry[type[Tool]] = Registry("tool")

# Import side-effect: registers the built-in tools. Below the registry so the
# decorator has something to register into.
from app.tools import builtin  # noqa: E402,F401

#: Tools every call gets unless a custom set is requested.
DEFAULT_TOOLS = ["record_result", "end_call"]

__all__ = [
    "tool_registry",
    "DEFAULT_TOOLS",
    "build_tools_schema",
    "register_handlers",
    "CallOutcome",
    "Tool",
    "ToolContext",
    "ToolHandler",
]


def _resolve(names: list[str] | None) -> list[Tool]:
    return [tool_registry.get(n)() for n in (names or DEFAULT_TOOLS)]


def build_tools_schema(names: list[str] | None = None, custom_tools: list | None = None):
    """Build the ``ToolsSchema`` advertised to the LLM for this call.

    ``custom_tools`` is a list of :class:`~app.tools.http_tool.ResolvedTool`
    (tenant-defined HTTP tools); their schemas are merged with the built-ins.
    """
    from pipecat.adapters.schemas.tools_schema import ToolsSchema

    schemas = [tool.schema for tool in _resolve(names)]
    schemas += [t.to_function_schema() for t in (custom_tools or [])]
    return ToolsSchema(standard_tools=schemas)


def register_handlers(
    llm, ctx: ToolContext, names: list[str] | None = None, custom_tools: list | None = None
) -> None:
    """Bind each selected tool's handler to ``ctx`` and register it on ``llm``.

    Built-in tools bind to the call's :class:`ToolContext`; custom HTTP tools
    are self-contained and bind their decrypted endpoint config.
    """
    from app.tools.http_tool import make_http_handler

    for tool in _resolve(names):
        llm.register_function(tool.schema.name, tool.make_handler(ctx))
    for t in custom_tools or []:
        llm.register_function(t.name, make_http_handler(t))
