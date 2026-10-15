"""AI provider factories — pluggable STT / TTS / LLM services.

Each leg has its own registry populated by the sibling modules. ``build_*``
dispatch by ``creds.provider_name`` and pass the resolved tenant credentials in.
The pipeline calls these and never references a concrete SDK or process env.
"""

from typing import Any

from app.config import ResolvedCreds
from app.providers.llm import llm_registry
from app.providers.stt import stt_registry
from app.providers.tts import tts_registry

__all__ = [
    "build_stt",
    "build_tts",
    "build_llm",
    "stt_registry",
    "tts_registry",
    "llm_registry",
]


def build_stt(creds: ResolvedCreds) -> Any:
    return stt_registry.get(creds.provider_name)(creds)


def build_tts(creds: ResolvedCreds) -> Any:
    return tts_registry.get(creds.provider_name)(creds)


def build_llm(creds: ResolvedCreds) -> Any:
    return llm_registry.get(creds.provider_name)(creds)
