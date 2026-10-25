"""Request/response DTOs for the /v1 API.

Secrets are write-only: they appear on create/update request bodies, never on
any response.
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

ProviderKind = Literal["stt", "tts", "llm", "telephony"]

# Reserved names — collide with the built-in tools every call already has.
_RESERVED_TOOL_NAMES = {"record_result", "end_call"}
_TOOL_NAME_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]{0,63}$")


# ---- connections ----


class ConnectionCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    provider_kind: ProviderKind
    provider_name: str
    # Decrypted secret blob, e.g. {"api_key": "..."} or Plivo
    # {"auth_id","auth_token","from_number"}. Write-only.
    secrets: dict[str, Any]


class ConnectionUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    secrets: dict[str, Any] | None = None


class ConnectionOut(BaseModel):
    id: uuid.UUID
    name: str
    provider_kind: str
    provider_name: str
    created_at: datetime


# ---- agents ----


class AgentCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    company: str | None = None
    role: str | None = None
    instructions: str = Field(min_length=1)
    first_message: str | None = None
    voice_id: str | None = None
    llm_model: str | None = None
    # Leave stt/tts/llm empty to use Offhook's own providers (where the server offers them).
    stt_connection_id: uuid.UUID | None = None
    tts_connection_id: uuid.UUID | None = None
    llm_connection_id: uuid.UUID | None = None
    telephony_connection_id: uuid.UUID | None = None
    provider_settings: dict[str, Any] = Field(default_factory=dict)
    # Custom HTTP tools the agent may call. Ownership validated server-side.
    tool_ids: list[uuid.UUID] = Field(default_factory=list)


class AgentOut(BaseModel):
    id: uuid.UUID
    name: str
    company: str | None
    role: str | None
    instructions: str
    first_message: str | None
    voice_id: str | None
    llm_model: str | None
    stt_connection_id: uuid.UUID | None
    tts_connection_id: uuid.UUID | None
    llm_connection_id: uuid.UUID | None
    telephony_connection_id: uuid.UUID | None
    provider_settings: dict[str, Any]
    tool_ids: list[uuid.UUID] = Field(default_factory=list)
    created_at: datetime


# ---- custom tools ----


class ToolCreate(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    description: str = Field(min_length=1, max_length=2000)
    # JSON-Schema-ish: {"properties": {<arg>: {"type","description"}}, "required": [...]}.
    parameters: dict[str, Any] = Field(default_factory=dict)
    method: Literal["GET", "POST"] = "GET"
    url: str = Field(min_length=1, max_length=2048)
    # Static auth headers, e.g. {"Authorization": "Bearer ..."}. Write-only, encrypted.
    headers: dict[str, str] = Field(default_factory=dict)
    timeout_seconds: int = Field(default=10, ge=1, le=20)

    @field_validator("name")
    @classmethod
    def _valid_name(cls, v: str) -> str:
        if not _TOOL_NAME_RE.match(v):
            raise ValueError(
                "name must be a valid identifier (letters, digits, underscore; "
                "not starting with a digit)"
            )
        if v in _RESERVED_TOOL_NAMES:
            raise ValueError(f"{v!r} is a reserved tool name")
        return v

    @field_validator("parameters")
    @classmethod
    def _valid_params(cls, v: dict) -> dict:
        props = v.get("properties", {})
        if not isinstance(props, dict):
            raise ValueError("parameters.properties must be an object")
        req = v.get("required", [])
        if not isinstance(req, list):
            raise ValueError("parameters.required must be a list")
        return v


class ToolUpdate(BaseModel):
    description: str | None = Field(default=None, min_length=1, max_length=2000)
    parameters: dict[str, Any] | None = None
    method: Literal["GET", "POST"] | None = None
    url: str | None = Field(default=None, min_length=1, max_length=2048)
    headers: dict[str, str] | None = None
    timeout_seconds: int | None = Field(default=None, ge=1, le=20)


class ToolOut(BaseModel):
    id: uuid.UUID
    name: str
    description: str
    parameters: dict[str, Any]
    method: str
    url: str
    has_auth: bool  # whether auth headers are configured (values never returned)
    timeout_seconds: int
    created_at: datetime


# ---- api keys ----


class ApiKeyCreate(BaseModel):
    name: str | None = Field(default=None, max_length=128)
    # Optional expiry. The key stops working this many days from now.
    expires_in_days: int | None = Field(default=None, ge=1, le=3650)


class ApiKeyCreated(BaseModel):
    id: uuid.UUID
    prefix: str
    key: str  # full plaintext, shown once
    expires_at: datetime | None
    created_at: datetime


class ApiKeyOut(BaseModel):
    id: uuid.UUID
    prefix: str
    name: str | None
    last_used_at: datetime | None
    revoked_at: datetime | None
    expires_at: datetime | None
    created_at: datetime


# ---- calls ----


class CallCreate(BaseModel):
    agent_id: uuid.UUID
    to_number: str = Field(min_length=3, max_length=32)
    from_number: str | None = None
    context: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)
    # Searchable key/value labels, e.g. {"region": "North", "motive": "sales"}.
    # Filter the activity feed with GET /v1/calls?tag=region:North.
    tags: dict[str, str] = Field(default_factory=dict)

    @field_validator("tags")
    @classmethod
    def _validate_tags(cls, v: dict[str, str]) -> dict[str, str]:
        if len(v) > 25:
            raise ValueError("at most 25 tags allowed")
        for key, val in v.items():
            if not key or len(key) > 64:
                raise ValueError("tag keys must be 1–64 characters")
            if not isinstance(val, str) or len(val) > 256:
                raise ValueError(f"tag value for {key!r} must be a string up to 256 characters")
        return v


class CallOut(BaseModel):
    id: uuid.UUID
    status: str
    direction: str
    provider_call_id: str | None = None


class CallDetailOut(BaseModel):
    id: uuid.UUID
    status: str
    direction: str
    to_number: str | None
    from_number: str | None
    provider_call_id: str | None
    outcome: dict[str, Any] | None
    error: str | None
    error_code: str | None = None
    has_recording: bool = False
    tags: dict[str, str] = Field(default_factory=dict)
    created_at: datetime
    started_at: datetime | None
    ended_at: datetime | None
