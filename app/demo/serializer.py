"""The demo's WebSocket wire format, as a Pipecat frame serializer.

Browser → server:
  * binary: microphone audio, 16 kHz mono 16-bit little-endian PCM.

Server → browser:
  * binary: the agent's voice, same format.
  * text: JSON events — ``{"type": "transcript", "who", "text"}``,
    ``{"type": "result", "key", "value"}``, ``{"type": "interrupt"}`` (stop
    playing buffered agent audio: the person started talking),
    ``{"type": "wrap_up"}``, ``{"type": "ended", "reason"}`` and
    ``{"type": "error", "error", "message"}``.
"""

from __future__ import annotations

import json

from pipecat.frames.frames import (
    Frame,
    InputAudioRawFrame,
    InterruptionFrame,
    OutputAudioRawFrame,
    OutputTransportMessageFrame,
    OutputTransportMessageUrgentFrame,
)
from pipecat.serializers.base_serializer import FrameSerializer

SAMPLE_RATE = 16_000
#: Largest audio message accepted from the browser: one second of audio.
MAX_CHUNK_BYTES = SAMPLE_RATE * 2


class DemoSerializer(FrameSerializer):
    """Raw PCM both ways, plus JSON events to the browser."""

    async def serialize(self, frame: Frame) -> str | bytes | None:
        """Turn an outgoing frame into a WebSocket message.

        Args:
            frame: A frame reaching the transport's output.

        Returns:
            PCM bytes for audio, JSON text for events, or None to send nothing.
        """
        if isinstance(frame, OutputAudioRawFrame):
            return frame.audio
        if isinstance(frame, InterruptionFrame):
            return json.dumps({"type": "interrupt"})
        if isinstance(frame, (OutputTransportMessageFrame, OutputTransportMessageUrgentFrame)):
            return json.dumps(frame.message)
        return None

    async def deserialize(self, data: str | bytes) -> Frame | None:
        """Turn a browser message into a frame.

        Args:
            data: One WebSocket message.

        Returns:
            An audio frame for well-formed PCM; None for anything else (text
            messages are ignored: the browser hangs up by closing the socket).
        """
        if not isinstance(data, (bytes, bytearray)):
            return None
        if not data or len(data) % 2 or len(data) > MAX_CHUNK_BYTES:
            return None
        return InputAudioRawFrame(audio=bytes(data), sample_rate=SAMPLE_RATE, num_channels=1)
