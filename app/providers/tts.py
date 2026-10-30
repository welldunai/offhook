"""Text-to-speech providers.

Each factory receives a :class:`~app.config.ResolvedCreds` (decrypted key +
non-secret settings like voice_id/model/emotion/speed) and returns a Pipecat
TTS service. No process env is read.
"""

from typing import Any

from app.config import ResolvedCreds
from app.registry import Registry

#: name → factory(creds) -> Pipecat TTS service.
tts_registry: Registry[Any] = Registry("TTS")


@tts_registry.register("cartesia")
def _build_cartesia(creds: ResolvedCreds) -> Any:
    from pipecat.services.cartesia.tts import CartesiaTTSService, GenerationConfig

    model = creds.setting("model", "sonic-3")
    # Sonic-3 takes emotion (free-form tone) + speed (0.6–1.5) via generation_config.
    params = None
    if str(model).startswith("sonic-3"):
        speed = creds.setting("speed")
        params = CartesiaTTSService.InputParams(
            generation_config=GenerationConfig(
                emotion=creds.setting("emotion") or None,
                speed=float(speed) if speed else None,
            )
        )

    # voice_id is part of the Cartesia credential (stored in the connection),
    # not env or a hardcoded default. A per-call/agent setting may override it;
    # otherwise it must be present on the connection (raises a clear error if not).
    return CartesiaTTSService(
        api_key=creds.secret("api_key"),
        voice_id=creds.setting("voice_id") or creds.secret("voice_id"),
        model=model,
        params=params,
    )


@tts_registry.register("openai")
def _build_openai(creds: ResolvedCreds) -> Any:
    from pipecat.services.openai.tts import OpenAITTSService

    # OpenAI exposes named voices ("alloy", "nova", ...) rather than ids.
    return OpenAITTSService(
        api_key=creds.secret("api_key"),
        voice=creds.setting("voice_id", "alloy"),
    )


@tts_registry.register("deepgram")
def _build_deepgram(creds: ResolvedCreds) -> Any:
    from pipecat.services.deepgram.tts import DeepgramTTSService

    # Deepgram's Aura voices are named ("aura-2-helena-en"), not ids.
    return DeepgramTTSService(
        api_key=creds.secret("api_key"),
        voice=creds.setting("voice_id", "aura-2-helena-en"),
    )
