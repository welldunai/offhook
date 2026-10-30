"""Recordings go to the HTTP store when RECORDINGS_URL is set, else to local disk."""

import uuid

import httpx
import pytest

import app.recording as recording
from app.recording import CallRecorder, load_recording, save_recording


def recorder() -> CallRecorder:
    r = CallRecorder()
    r.audio, r.sample_rate = b"\x01\x00" * 160, 8000
    return r


@pytest.fixture
def store(monkeypatch):
    """An in-memory HTTP store at http://recordings.internal."""
    kept: dict[str, bytes] = {}

    def handle(req: httpx.Request) -> httpx.Response:
        key = req.url.path.lstrip("/")
        if req.method == "PUT":
            kept[key] = req.content
            return httpx.Response(200)
        return httpx.Response(200, content=kept[key]) if key in kept else httpx.Response(404)

    real = httpx.AsyncClient
    monkeypatch.setattr(recording.httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handle), **kw))
    monkeypatch.setattr(recording.settings, "recordings_url", "http://recordings.internal")
    return kept


@pytest.mark.asyncio
async def test_saved_to_the_store_and_read_back(store):
    tenant, call = uuid.uuid4(), uuid.uuid4()
    location = await save_recording(tenant, call, recorder())
    assert location == f"store:{tenant}/{call}.wav"
    assert list(store) == [f"{tenant}/{call}.wav"]
    wav = await load_recording(location)
    assert wav[:4] == b"RIFF"


@pytest.mark.asyncio
async def test_a_missing_recording_reads_as_none(store):
    assert await load_recording("store:nope/gone.wav") is None


@pytest.mark.asyncio
async def test_without_a_store_it_goes_to_disk(tmp_path, monkeypatch):
    monkeypatch.setattr(recording.settings, "recordings_url", None)
    monkeypatch.setattr(recording.settings, "recordings_dir", str(tmp_path))
    location = await save_recording(uuid.uuid4(), uuid.uuid4(), recorder())
    assert location.startswith(str(tmp_path))
    assert (await load_recording(location))[:4] == b"RIFF"


@pytest.mark.asyncio
async def test_no_audio_means_no_recording(store):
    assert await save_recording(uuid.uuid4(), uuid.uuid4(), CallRecorder()) is None
    assert store == {}
