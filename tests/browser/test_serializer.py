"""The demo wire format: raw PCM both ways, JSON events to the browser."""

import json

from pipecat.frames.frames import (
    InputAudioRawFrame,
    InterruptionFrame,
    OutputAudioRawFrame,
    OutputTransportMessageUrgentFrame,
    TextFrame,
)

from app.browser.serializer import MAX_CHUNK_BYTES, BrowserCallSerializer


async def test_audio_in_becomes_16k_mono_frames():
    frame = await BrowserCallSerializer().deserialize(b"\x01\x00" * 160)
    assert isinstance(frame, InputAudioRawFrame)
    assert (frame.sample_rate, frame.num_channels, len(frame.audio)) == (16000, 1, 320)


async def test_ignores_text_odd_empty_and_oversized_messages():
    s = BrowserCallSerializer()
    for data in ('{"type":"hangup"}', b"", b"\x00", b"\x00" * (MAX_CHUNK_BYTES + 2)):
        assert await s.deserialize(data) is None


async def test_audio_out_is_raw_pcm_and_events_are_json():
    s = BrowserCallSerializer()
    assert await s.serialize(OutputAudioRawFrame(audio=b"\x02\x00", sample_rate=16000, num_channels=1)) == b"\x02\x00"
    assert json.loads(await s.serialize(InterruptionFrame())) == {"type": "interrupt"}
    msg = {"type": "transcript", "who": "agent", "text": "Hi"}
    assert json.loads(await s.serialize(OutputTransportMessageUrgentFrame(message=msg))) == msg
    assert await s.serialize(TextFrame(text="not sent")) is None


async def test_drops_pipecats_own_rtvi_messages():
    s = BrowserCallSerializer()
    rtvi = {"label": "rtvi-ai", "type": "bot-tts-text", "data": {"text": "Hi"}}
    assert await s.serialize(OutputTransportMessageUrgentFrame(message=rtvi)) is None
    assert await s.serialize(OutputTransportMessageUrgentFrame(message={"type": "metrics"})) is None
    assert await s.serialize(OutputTransportMessageUrgentFrame(message="text")) is None
