"""Per-call voice configuration — now carries *resolved* tenant credentials.

In the multi-tenant design, a call's provider credentials come from the
tenant's stored, encrypted *connections* (see ``app/tenancy/resolve.py``), not
from process-global env. ``VoiceConfig`` therefore holds a ``ResolvedCreds``
per leg (STT/TTS/LLM/telephony) instead of provider-name strings that imply env
lookups. Provider factories receive a ``ResolvedCreds`` and read only what they
need.

``SUPPORTED_PROVIDERS`` is the locked allow-list the connections API validates
against — tenants bring keys for these providers only (no arbitrary endpoints).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

STTProvider = Literal["deepgram"]
TTSProvider = Literal["cartesia", "openai"]
LLMProvider = Literal["openrouter", "openai", "gemini", "groq"]
TelephonyProviderName = Literal["plivo", "twilio"]

#: Allow-list per provider kind. The connections API rejects anything else.
SUPPORTED_PROVIDERS: dict[str, set[str]] = {
    "stt": {"deepgram"},
    "tts": {"cartesia", "openai"},
    "llm": {"openrouter", "openai", "gemini", "groq"},
    "telephony": {"plivo", "twilio"},
}


@dataclass(frozen=True)
class ResolvedCreds:
    """A single provider leg, resolved for one call.

    ``secrets`` is the decrypted blob from the tenant's connection (e.g.
    ``{"api_key": ...}`` or Plivo ``{"auth_id","auth_token","from_number"}``).
    ``settings`` are non-secret tunables (model, voice_id, language, emotion,
    speed) merged from the agent. Neither is ever logged.
    """

    provider_name: str
    secrets: dict[str, Any] = field(default_factory=dict)
    settings: dict[str, Any] = field(default_factory=dict)

    def secret(self, key: str) -> str:
        value = self.secrets.get(key)
        if not value:
            raise RuntimeError(
                f"connection for '{self.provider_name}' is missing secret '{key}'"
            )
        return value

    def setting(self, key: str, default: Any = None) -> Any:
        return self.settings.get(key, default)


@dataclass(frozen=True)
class VoiceConfig:
    """Everything one call needs, with tenant credentials already resolved."""

    stt: ResolvedCreds
    tts: ResolvedCreds
    llm: ResolvedCreds
    telephony: ResolvedCreds | None = None
    language: str = "en"
    debug_logging: bool = True
