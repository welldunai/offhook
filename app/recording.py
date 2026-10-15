"""Call audio recording — capture the mixed call audio and persist it as WAV.

A :class:`CallRecorder` is a plain holder the pipeline fills via pipecat's
``AudioBufferProcessor`` (user + bot mixed to mono PCM). On call end we encode
it to a WAV and write it to local storage under
``<recordings_dir>/<tenant_id>/<call_id>.wav``.

Local files are fine for dev; point ``RECORDINGS_DIR`` at a mounted volume, or
swap ``save_recording`` for object storage (S3/GCS), in production.
"""

from __future__ import annotations

import io
import os
import uuid
import wave

from app.settings import settings


class CallRecorder:
    """Mutable holder the pipeline writes the final mixed audio into."""

    def __init__(self) -> None:
        self.audio: bytes | None = None
        self.sample_rate: int = 0
        self.num_channels: int = 1


def to_wav(audio: bytes, sample_rate: int, num_channels: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(num_channels or 1)
        wf.setsampwidth(2)  # 16-bit PCM
        wf.setframerate(sample_rate or 8000)
        wf.writeframes(audio)
    return buf.getvalue()


def recording_path(tenant_id: uuid.UUID, call_id: uuid.UUID) -> str:
    return os.path.join(settings.recordings_dir, str(tenant_id), f"{call_id}.wav")


def save_recording(tenant_id: uuid.UUID, call_id: uuid.UUID, recorder: CallRecorder) -> str | None:
    """Encode + write the recording. Returns the path, or None if there's no audio."""
    if not recorder.audio:
        return None
    path = recording_path(tenant_id, call_id)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(to_wav(recorder.audio, recorder.sample_rate, recorder.num_channels))
    return path
