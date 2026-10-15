"""Transcript capture — records the conversation as it happens.

A pipeline observer that turns frames into conversation turns and appends them
to the call's :class:`CallOutcome`, which is persisted as the call's transcript
(its "content") when the call ends.

  * ``TranscriptionFrame`` (final user STT)        → a ``user`` turn.
  * ``LLMTextFrame`` chunks between ``LLMFullResponseStart/EndFrame`` → an
    ``assistant`` turn (what the agent decided to say).

An observer sees every frame at *each* processor boundary, so the same frame is
delivered multiple times — we de-duplicate by frame id.
"""

from __future__ import annotations

from pipecat.frames.frames import (
    LLMFullResponseEndFrame,
    LLMTextFrame,
    TranscriptionFrame,
)
from pipecat.observers.base_observer import BaseObserver, FramePushed

from app.tools.base import CallOutcome


class TranscriptCollector(BaseObserver):
    def __init__(self, outcome: CallOutcome) -> None:
        super().__init__()
        self._outcome = outcome
        self._seen: set[int] = set()
        self._assistant_buf: list[str] = []

    async def on_push_frame(self, data: FramePushed) -> None:
        frame = data.frame
        # De-dup by the frame's own stable id: a frame is observed at every
        # processor boundary. (Python id() would be unsafe — freed ids reuse.)
        fid = getattr(frame, "id", None)
        if fid is None or fid in self._seen:
            return

        if isinstance(frame, TranscriptionFrame):
            self._seen.add(fid)
            text = (frame.text or "").strip()
            if text:
                self._outcome.transcript.append(
                    {"role": "user", "text": text, "t": round(data.timestamp / 1e9, 3)}
                )
        elif isinstance(frame, LLMTextFrame):
            self._seen.add(fid)
            self._assistant_buf.append(frame.text)
        elif isinstance(frame, LLMFullResponseEndFrame):
            self._seen.add(fid)
            from app.textfilter import strip_tool_syntax

            text = strip_tool_syntax("".join(self._assistant_buf).strip())
            self._assistant_buf = []
            if text:
                self._outcome.transcript.append(
                    {"role": "assistant", "text": text, "t": round(data.timestamp / 1e9, 3)}
                )
