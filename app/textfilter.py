"""Safety net: strip leaked tool-call syntax from the agent's spoken text.

Some models (especially small ones) occasionally *verbalize* a tool call —
emitting Llama's ``<function=name>{...}</function>`` format as plain text
instead of a structured call. Left alone, the TTS speaks it aloud.

``ToolCallTextFilter`` sits between the LLM and the TTS and removes that syntax
from the streaming text before it's synthesized. It's a stateful streaming
suppressor: normal text flows straight through (no added latency); only when a
``<function`` marker appears does it drop until the call ends (the JSON's closing
brace, plus an optional ``</function>``).

``strip_tool_syntax`` is the one-shot version, used to clean the stored
transcript (which is assembled from the full text, so a regex suffices there).
"""

from __future__ import annotations

import re

from pipecat.frames.frames import (
    Frame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

_TOOL_BLOCK = re.compile(r"<function\b[^>]*>\s*\{.*?\}\s*(?:</function>)?", re.DOTALL | re.IGNORECASE)
_STRAY = re.compile(r"</?function[^>]*>|<\|python_tag\|>|<\|eom_id\|>", re.IGNORECASE)


def strip_tool_syntax(text: str) -> str:
    """Remove tool-call syntax from a complete string (for transcripts)."""
    text = _TOOL_BLOCK.sub("", text)
    text = _STRAY.sub("", text)
    return re.sub(r"[ \t]{2,}", " ", text).strip()


_TAG = "<function"


class ToolCallTextFilter(FrameProcessor):
    """Drop leaked ``<function…>{…}`` tool-call text from the LLM→TTS stream."""

    def __init__(self) -> None:
        super().__init__()
        self._suppress = False       # inside a tool-call block
        self._hold = ""              # trailing partial that may start a tag
        self._skip_close = False     # drop a leading </function> on the next chunk

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if isinstance(frame, LLMFullResponseStartFrame):
            self._suppress = False
            self._hold = ""
            self._skip_close = False
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, LLMFullResponseEndFrame):
            # A held partial that never became a real tag is real text — emit it.
            if self._hold and not self._suppress:
                await self.push_frame(LLMTextFrame(self._hold), direction)
            self._hold = ""
            self._suppress = False
            self._skip_close = False
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, LLMTextFrame):
            frame.text = self._consume(frame.text)
            await self.push_frame(frame, direction)
            return

        await self.push_frame(frame, direction)

    def _consume(self, text: str) -> str:
        s = self._hold + text
        self._hold = ""
        out: list[str] = []
        i, n = 0, len(s)
        while i < n:
            if self._suppress:
                brace = s.find("}", i)
                if brace == -1:
                    i = n  # whole chunk is inside the block
                else:
                    j = brace + 1
                    m = re.match(r"\s*</function>", s[j:], re.IGNORECASE)
                    if m:
                        j += m.end()
                    else:
                        self._skip_close = True  # </function> may arrive next chunk
                    i = j
                    self._suppress = False
                continue

            # Drop a stray </function> left over from a previous chunk's block.
            if self._skip_close:
                m = re.match(r"\s*</function>", s[i:], re.IGNORECASE)
                if m:
                    i += m.end()
                self._skip_close = False
                continue

            idx = s.lower().find(_TAG, i)
            if idx == -1:
                rest = s[i:]
                keep = self._partial_prefix(rest)
                out.append(rest[: len(rest) - len(keep)] if keep else rest)
                self._hold = keep
                i = n
            else:
                out.append(s[i:idx])
                self._suppress = True
                i = idx + len(_TAG)
        return "".join(out)

    @staticmethod
    def _partial_prefix(rest: str) -> str:
        """Longest suffix of ``rest`` that is a prefix of ``<function`` (so we
        don't emit half a tag that completes in the next chunk)."""
        for k in range(min(len(rest), len(_TAG) - 1), 0, -1):
            if _TAG.startswith(rest[-k:].lower()):
                return rest[-k:]
        return ""
