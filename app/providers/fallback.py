"""Offhook's own Cartesia key falling back to Deepgram's voice.

Offhook's provided voice and the website demo speak through one Cartesia key.
When that key can't speak (out of credits, revoked, Cartesia down), calls use
Deepgram's Aura voice with Offhook's Deepgram key instead of failing. A user's own
Cartesia connection is never swapped: that's their account to fix.
"""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable

import httpx

from app.config import ResolvedCreds
from app.logger import logger

#: Seconds to trust a check's answer before asking Cartesia again.
CHECK_TTL = 300.0

#: The Deepgram voice used in Cartesia's place.
FALLBACK_VOICE = "aura-2-helena-en"

# api_key → (checked_at, available)
_checks: dict[str, tuple[float, bool]] = {}


async def check_cartesia(api_key: str, voice_id: str) -> bool:
    """Ask Cartesia to say one word with this key.

    Args:
        api_key: The Cartesia API key.
        voice_id: A voice the key can use.

    Returns:
        True if Cartesia produced audio; False on any error, refusal or timeout.
    """
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.post(
                "https://api.cartesia.ai/tts/bytes",
                headers={"X-API-Key": api_key, "Cartesia-Version": "2024-11-13"},
                json={
                    "model_id": "sonic-3",
                    "transcript": "Hi.",
                    "voice": {"mode": "id", "id": voice_id},
                    "output_format": {"container": "raw", "encoding": "pcm_s16le", "sample_rate": 16000},
                },
            )
    except httpx.HTTPError as e:
        logger.warning(f"[voice] Cartesia check failed: {e!r}")
        return False
    if r.status_code != 200:
        logger.warning(f"[voice] Cartesia can't speak: {r.status_code} {r.text[:120]}")
        return False
    return True


async def cartesia_available(
    api_key: str,
    voice_id: str,
    *,
    check: Callable[[str, str], Awaitable[bool]] | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> bool:
    """Whether this Cartesia key can speak, checking at most every ``CHECK_TTL`` seconds.

    Args:
        api_key: The Cartesia API key.
        voice_id: A voice the key can use.
        check: Asks Cartesia; defaults to ``check_cartesia``.
        clock: Monotonic seconds; tests pass a fake.

    Returns:
        The latest check's answer.
    """
    cached = _checks.get(api_key)
    if cached is not None and clock() - cached[0] < CHECK_TTL:
        return cached[1]
    ok = await (check or check_cartesia)(api_key, voice_id)
    _checks[api_key] = (clock(), ok)
    return ok


async def with_fallback(
    tts: ResolvedCreds,
    deepgram_key: str | None,
    *,
    available: Callable[[str, str], Awaitable[bool]] | None = None,
) -> ResolvedCreds:
    """Swap Offhook's Cartesia voice for Deepgram's when Cartesia can't speak.

    Args:
        tts: Offhook's own TTS credentials for the call.
        deepgram_key: Offhook's Deepgram key, or None if there isn't one.
        available: Whether a Cartesia key can speak; defaults to ``cartesia_available``.

    Returns:
        ``tts`` unchanged, or Deepgram credentials. The agent's Cartesia settings
        (voice, emotion, speed) don't apply to Deepgram, so they're dropped.
    """
    if tts.provider_name != "cartesia" or not deepgram_key:
        return tts
    if await (available or cartesia_available)(tts.secret("api_key"), tts.secret("voice_id")):
        return tts
    logger.warning("[voice] Offhook's Cartesia key can't speak; using Deepgram's voice")
    return ResolvedCreds("deepgram", {"api_key": deepgram_key}, {"voice_id": FALLBACK_VOICE})
