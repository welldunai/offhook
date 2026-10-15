"""Typed application settings, validated at boot.

Replaces scattered ``os.getenv`` calls with a single, validated source of
truth. Anything operational (DB URL, master encryption keys, public base URL,
environment) lives here. Per-tenant *provider* credentials do NOT live here —
those are stored encrypted in the database (see ``app/crypto``).

Loaded once as the module-level ``settings`` singleton. In production, missing
or malformed required values fail fast at import.
"""

from __future__ import annotations

import base64
from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    # ---- Environment ----
    env: Literal["dev", "prod"] = Field(default="dev", alias="ENV")
    log_level: str = Field(default="DEBUG", alias="LOG_LEVEL")

    # ---- Database ----
    database_url: str = Field(
        default="postgresql+asyncpg://voice:voice@localhost:5432/voice",
        alias="DATABASE_URL",
    )

    # ---- Envelope encryption master key(s) ----
    # Active master key (base64 of 32 raw bytes) used to wrap new tenant DEKs.
    master_encryption_key: str | None = Field(default=None, alias="MASTER_ENCRYPTION_KEY")
    # Identifier of the active master key, recorded on each wrapped DEK so old
    # keys can stay available for unwrap during rotation (set MASTER_ENCRYPTION_KEY_<ID>).
    master_key_id: str = Field(default="v1", alias="MASTER_KEY_ID")
    # Key provider: 'env' (master key from env) or 'kms' (AWS KMS, needs KMS_KEY_ID).
    key_provider: Literal["env", "kms"] = Field(default="env", alias="KEY_PROVIDER")
    kms_key_id: str | None = Field(default=None, alias="KMS_KEY_ID")

    # Postgres row-level security (defense-in-depth). Requires the two-role setup
    # (see docs); off by default so the worker/carrier paths keep working.
    enable_rls: bool = Field(default=False, alias="ENABLE_RLS")

    # ---- Clerk (dashboard user auth) ----
    # Issuer of Clerk session JWTs, e.g. https://your-app.clerk.accounts.dev.
    clerk_issuer: str | None = Field(default=None, alias="CLERK_ISSUER")
    # JWKS endpoint; derived from the issuer if unset.
    clerk_jwks_url: str | None = Field(default=None, alias="CLERK_JWKS_URL")

    @property
    def clerk_enabled(self) -> bool:
        return bool(self.clerk_issuer or self.clerk_jwks_url)

    @property
    def clerk_jwks(self) -> str | None:
        if self.clerk_jwks_url:
            return self.clerk_jwks_url
        if self.clerk_issuer:
            return self.clerk_issuer.rstrip("/") + "/.well-known/jwks.json"
        return None

    # ---- Telephony / public callbacks ----
    # The externally reachable base URL carriers call back on. In prod this is
    # required and we never trust request headers (x-forwarded-host) to derive it.
    public_base_url: str | None = Field(default=None, alias="PUBLIC_BASE_URL")

    # ---- Dev affordances ----
    # The pipecat prebuilt playground UI + default-agent web calls. Off in prod.
    enable_prebuilt_ui: bool = Field(default=True, alias="ENABLE_PREBUILT_UI")
    # Which agent the dev playground talks to. If unset, the first agent is used.
    dev_agent_id: str | None = Field(default=None, alias="DEV_AGENT_ID")
    # DEV ONLY: allow webhook delivery to private/loopback hosts (local testing).
    webhook_allow_private: bool = Field(default=False, alias="WEBHOOK_ALLOW_PRIVATE")
    # Where call audio recordings are written (local FS; use object storage in prod).
    recordings_dir: str = Field(default="recordings", alias="RECORDINGS_DIR")

    # Comma-separated allowed origins for the dashboard (browser CORS).
    # Covers the dashboard's dedicated dev port + the common Vite fallbacks.
    cors_origins: str = Field(
        default=(
            "http://localhost:5273,http://localhost:4273,"
            "http://localhost:5173,http://localhost:5174,http://localhost:5175"
        ),
        alias="CORS_ORIGINS",
    )

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @field_validator("master_encryption_key")
    @classmethod
    def _validate_master_key(cls, v: str | None) -> str | None:
        if v is None:
            return None
        try:
            raw = base64.b64decode(v, validate=True)
        except Exception as exc:  # noqa: BLE001
            raise ValueError("MASTER_ENCRYPTION_KEY must be valid base64") from exc
        if len(raw) != 32:
            raise ValueError("MASTER_ENCRYPTION_KEY must decode to exactly 32 bytes")
        return v

    @model_validator(mode="after")
    def _prod_requirements(self) -> "Settings":
        if self.env == "prod":
            if not self.master_encryption_key:
                raise ValueError("MASTER_ENCRYPTION_KEY is required in prod")
            if not self.public_base_url:
                raise ValueError("PUBLIC_BASE_URL is required in prod")
            if self.enable_prebuilt_ui:
                # The prebuilt UI starts unauthenticated default-agent calls.
                raise ValueError("ENABLE_PREBUILT_UI must be false in prod")
            if self.webhook_allow_private:
                raise ValueError("WEBHOOK_ALLOW_PRIVATE must be false in prod")
        return self

    @property
    def is_prod(self) -> bool:
        return self.env == "prod"


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
