"""Call audio recording — capture the mixed call audio and persist it as WAV.

A :class:`CallRecorder` is a plain holder the pipeline fills via pipecat's
``AudioBufferProcessor`` (user + bot mixed to mono PCM). On call end we encode
it to a WAV and write it to local storage under
``<recordings_dir>/<tenant_id>/<call_id>.wav``.

Local files are fine for dev. With ``RECORDINGS_URL`` set, recordings go to that
HTTP store instead (on Cloudflare, the Worker keeps them in R2), and the call
records ``store:<tenant_id>/<call_id>.wav``.
"""

from __future__ import annotations

import io
import os
import uuid
import wave

import httpx

from app.settings import settings

#: Marks a recording kept in the HTTP store rather than on local disk.
STORE_PREFIX = "store:"


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


async def save_recording(tenant_id: uuid.UUID, call_id: uuid.UUID, recorder: CallRecorder) -> str | None:
    """Encode and store the recording.

    Args:
        tenant_id: The call's workspace.
        call_id: The call.
        recorder: What the pipeline captured.

    Returns:
        Where it was stored (a local path, or ``store:<key>``), or None if there's no audio.
    """
    if not recorder.audio:
        return None
    wav = to_wav(recorder.audio, recorder.sample_rate, recorder.num_channels)
    if settings.recordings_url:
        key = f"{tenant_id}/{call_id}.wav"
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.put(f"{settings.recordings_url}/{key}", content=wav)
            r.raise_for_status()
        return STORE_PREFIX + key
    path = recording_path(tenant_id, call_id)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(wav)
    return path


async def load_recording(location: str) -> bytes | None:
    """Read a stored recording back.

    Args:
        location: What ``save_recording`` returned.

    Returns:
        The WAV bytes, or None if it's gone.
    """
    if location.startswith(STORE_PREFIX):
        if not settings.recordings_url:
            return None
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.get(f"{settings.recordings_url}/{location[len(STORE_PREFIX):]}")
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.content
    if not os.path.exists(location):
        return None
    with open(location, "rb") as f:
        return f.read()
