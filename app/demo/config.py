"""Settings for the demo voice server, read from the environment (or ``.env``).

Kept apart from ``app.settings`` on purpose: the demo has no database, tenants
or master key, only provider keys and what it shares with the Worker.
"""

from __future__ import annotations

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class DemoSettings(BaseSettings):
    """Everything the voice server needs. Secrets are never logged."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    deepgram_api_key: str = Field(default="", alias="DEEPGRAM_API_KEY")
    cartesia_api_key: str = Field(default="", alias="CARTESIA_API_KEY")
    cartesia_voice_id: str = Field(default="", alias="CARTESIA_VOICE_ID")
    groq_api_key: str = Field(default="", alias="GROQ_API_KEY")
    #: The agent's model on demo calls (Groq). Groq retired its Llama models.
    llm_model: str = Field(default="openai/gpt-oss-20b", alias="DEMO_LLM_MODEL")
    #: gpt-oss reasons before answering; "low" keeps the reply gap short. Empty to omit.
    llm_reasoning_effort: str = Field(default="low", alias="DEMO_LLM_REASONING_EFFORT")

    hmac_secret: str = Field(default="", alias="DEMO_HMAC_SECRET")
    worker_url: str = Field(default="http://localhost:8787", alias="WORKER_URL")
    #: Pages allowed to open the audio WebSocket (checked against Origin).
    allowed_origins: str = Field(
        default="https://offhook.welldun.ai,http://localhost:4321,http://localhost:4370",
        alias="DEMO_ALLOWED_ORIGINS",
    )
    #: Calls this machine runs at once. The Worker's Gate is the real limit;
    #: this is a backstop so a bug there can't overload the machine.
    max_local_calls: int = Field(default=5, alias="DEMO_MAX_LOCAL_CALLS")

    def missing(self) -> list[str]:
        """Return the names of required settings that are empty."""
        required = {
            "DEEPGRAM_API_KEY": self.deepgram_api_key,
            "CARTESIA_API_KEY": self.cartesia_api_key,
            "CARTESIA_VOICE_ID": self.cartesia_voice_id,
            "GROQ_API_KEY": self.groq_api_key,
            "DEMO_HMAC_SECRET": self.hmac_secret,
        }
        return [name for name, value in required.items() if not value]

    def origins(self) -> set[str]:
        """Return the allowed origins as a set."""
        return {o.strip() for o in self.allowed_origins.split(",") if o.strip()}
