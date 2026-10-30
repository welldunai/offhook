"""Offhook's Cartesia voice falls back to Deepgram's when Cartesia can't speak."""

import pytest

import app.providers.fallback as fallback
from app.config import ResolvedCreds

CARTESIA = ResolvedCreds("cartesia", {"api_key": "ck", "voice_id": "v1"}, {"emotion": "calm"})


def answers(*results):
    """A fake check returning ``results`` in turn, recording each call."""
    calls = []

    async def check(key, voice):
        calls.append((key, voice))
        return results[len(calls) - 1]

    return check, calls


@pytest.mark.asyncio
async def test_a_working_cartesia_key_is_kept():
    check, _ = answers(True)
    assert await fallback.with_fallback(CARTESIA, "dk", available=lambda k, v: check(k, v)) is CARTESIA


@pytest.mark.asyncio
async def test_a_cartesia_key_that_cant_speak_becomes_deepgram():
    check, calls = answers(False)
    tts = await fallback.with_fallback(CARTESIA, "dk", available=lambda k, v: check(k, v))
    assert tts.provider_name == "deepgram"
    assert tts.secret("api_key") == "dk"
    assert tts.settings == {"voice_id": fallback.FALLBACK_VOICE}  # Cartesia's emotion doesn't carry over
    assert calls == [("ck", "v1")]


@pytest.mark.asyncio
async def test_without_a_deepgram_key_cartesia_is_kept():
    check, calls = answers(False)
    assert await fallback.with_fallback(CARTESIA, None, available=lambda k, v: check(k, v)) is CARTESIA
    assert calls == []


@pytest.mark.asyncio
async def test_other_voices_are_left_alone():
    openai = ResolvedCreds("openai", {"api_key": "ok"})
    assert await fallback.with_fallback(openai, "dk") is openai


@pytest.mark.asyncio
async def test_the_answer_is_reused_for_a_while():
    check, calls = answers(False, True)
    now = [0.0]
    ask = lambda: fallback.cartesia_available("ck", "v1", check=check, clock=lambda: now[0])
    assert await ask() is False
    now[0] = fallback.CHECK_TTL - 1
    assert await ask() is False
    assert len(calls) == 1
    now[0] = fallback.CHECK_TTL + 1
    assert await ask() is True
    assert len(calls) == 2


def test_deepgram_voice_builds():
    from app.providers import build_tts

    service = build_tts(ResolvedCreds("deepgram", {"api_key": "dk"}, {"voice_id": fallback.FALLBACK_VOICE}))
    assert type(service).__name__ == "DeepgramTTSService"
