"""System prompt + opener construction.

The system prompt is assembled per-call from three parts:
  1. The caller-supplied `instructions` (the agent's behaviour).
  2. Voice-specific constraints (short sentences, no markdown, etc.) — injected
     here so the API consumer never has to think about speech rendering.
  3. The free-form `context` dict, rendered as a key/value block so the agent
     has the call's facts in scope.
"""

from typing import Any

from app.schemas import CallContext


def _format_context(context: dict[str, Any]) -> str:
    if not context:
        return "(no additional context provided)"
    lines = []
    for key, value in context.items():
        label = str(key).replace("_", " ")
        lines.append(f"  - {label}: {value}")
    return "\n".join(lines)


def _identity_line(ctx: CallContext) -> str:
    a = ctx.agent
    parts = [f"You are {a.name}"]
    if a.role:
        parts.append(f", a {a.role}")
    if a.company:
        parts.append(f" at {a.company}")
    return "".join(parts) + "."


VOICE_CONSTRAINTS = """HOW TO SPEAK — your words are spoken aloud in real time, so sound like a real person:
  - Be warm and natural. Use contractions ("I'm", "you're", "that's") and an
    easy, conversational rhythm — not stiff or formal.
  - Show you're listening: brief acknowledgements ("got it", "totally",
    "oh, no worries") and react to the other person's tone.
  - Vary your sentences. A short reaction, then your point. Don't sound scripted.
  - Keep turns short — a sentence or two — and ask one question at a time, then wait.
  - No markdown, bullet points, emojis, or special characters.
  - Spell out amounts and dates the way a person would say them aloud.
  - If the other person interrupts, stop and listen.
  - Never invent facts that are not in your instructions or the call context.
  - Only record an answer with `record_result` once the person has actually
    given it. Never record placeholders like "?" or "unknown" ahead of asking.
  - End the call with the `end_call` tool only once the conversation is truly
    over: you've said goodbye and the other person has nothing more to add.
    Never call it in the same turn as a question; wait for the answer first."""


def build_system_prompt(ctx: CallContext) -> str:
    """Assemble the system instruction passed to the LLM service."""
    return f"""{_identity_line(ctx)}

{ctx.agent.instructions.strip()}

{VOICE_CONSTRAINTS}

CALL CONTEXT — facts you know about this specific call:
{_format_context(ctx.context)}
"""


def build_opener(ctx: CallContext) -> str:
    """First line spoken when the call connects."""
    if ctx.agent.first_message:
        return ctx.agent.first_message
    who = ctx.agent.name
    if ctx.agent.company:
        who = f"{ctx.agent.name} from {ctx.agent.company}"
    return f"Hello, this is {who}. How can I help you today?"
