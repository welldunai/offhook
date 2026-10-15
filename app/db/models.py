"""SQLAlchemy models — the multi-tenant schema.

Every tenant-scoped table carries ``tenant_id`` (FK + index). Access goes
through ``app/db/repositories.py``, whose methods require ``tenant_id`` so a
cross-tenant query can't happen by accident.

Secrets are never stored in plaintext: ``connections`` holds AES-GCM
``ciphertext`` + ``nonce``; ``tenant_keys`` holds the wrapped per-tenant DEK;
``api_keys`` holds an argon2 ``key_hash``.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    DateTime,
    ForeignKey,
    Index,
    LargeBinary,
    String,
    Text,
    text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


def _uuid_pk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


def _created() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now())


def _updated() -> Mapped[datetime]:
    return mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Tenant(Base):
    __tablename__ = "tenants"

    id: Mapped[uuid.UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(Text, nullable=False)
    slug: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active")
    # Limits (Phase 3). API requests/min, concurrent live calls, calls/calendar-month.
    rate_limit_per_min: Mapped[int] = mapped_column(nullable=False, default=120, server_default=text("120"))
    max_concurrent_calls: Mapped[int] = mapped_column(nullable=False, default=10, server_default=text("10"))
    monthly_call_cap: Mapped[int | None] = mapped_column(nullable=True)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()


class User(Base):
    """A human who signs in to the dashboard (via Clerk), mapped to a tenant."""

    __tablename__ = "users"

    id: Mapped[uuid.UUID] = _uuid_pk()
    clerk_user_id: Mapped[str] = mapped_column(String(80), nullable=False, unique=True)
    tenant_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    email: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = _created()

    __table_args__ = (Index("ix_users_tenant", "tenant_id"),)


class ApiKey(Base):
    __tablename__ = "api_keys"

    id: Mapped[uuid.UUID] = _uuid_pk()
    tenant_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    # Plaintext, indexed handle for O(1) lookup. The secret itself is never stored.
    prefix: Mapped[str] = mapped_column(String(40), nullable=False, unique=True)
    key_hash: Mapped[str] = mapped_column(Text, nullable=False)  # argon2id
    name: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Optional expiry — the key is rejected after this instant.
    expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = _created()

    __table_args__ = (
        Index("ix_api_keys_tenant_id", "tenant_id"),
        Index("ix_api_keys_active", "prefix", postgresql_where=(revoked_at.is_(None))),
    )


class TenantKey(Base):
    """Per-tenant data-encryption key (DEK), wrapped by a master key (KEK)."""

    __tablename__ = "tenant_keys"

    tenant_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("tenants.id", ondelete="CASCADE"),
        primary_key=True,
    )
    wrapped_dek: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    master_key_id: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = _created()


class Connection(Base):
    """A tenant's stored, encrypted provider credentials."""

    __tablename__ = "connections"

    id: Mapped[uuid.UUID] = _uuid_pk()
    tenant_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    provider_kind: Mapped[str] = mapped_column(String(16), nullable=False)  # stt/tts/llm/telephony
    provider_name: Mapped[str] = mapped_column(String(32), nullable=False)
    # AES-GCM of the secret JSON blob (tag appended by GCM). AAD binds it to
    # tenant_id|connection_id|provider_name.
    ciphertext: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    nonce: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)  # 12 bytes
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()

    __table_args__ = (
        UniqueConstraint("tenant_id", "name", name="uq_connections_tenant_name"),
        Index("ix_connections_tenant_id", "tenant_id"),
        Index("ix_connections_tenant_provider", "tenant_id", "provider_name"),
    )


class Agent(Base):
    __tablename__ = "agents"

    id: Mapped[uuid.UUID] = _uuid_pk()
    tenant_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(Text, nullable=False)
    company: Mapped[str | None] = mapped_column(Text, nullable=True)
    role: Mapped[str | None] = mapped_column(Text, nullable=True)
    instructions: Mapped[str] = mapped_column(Text, nullable=False)
    first_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    voice_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    llm_model: Mapped[str | None] = mapped_column(Text, nullable=True)

    stt_connection_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("connections.id", ondelete="RESTRICT"), nullable=True
    )
    tts_connection_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("connections.id", ondelete="RESTRICT"), nullable=True
    )
    llm_connection_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("connections.id", ondelete="RESTRICT"), nullable=True
    )
    telephony_connection_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("connections.id", ondelete="RESTRICT"), nullable=True
    )
    # Non-secret tunables: stt_model, tts_model, language, emotion, speed, ...
    provider_settings: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    # Custom HTTP tools the agent may call mid-conversation (custom_tools.id).
    # Stored as an array of ids; ownership validated at write time. Frozen into
    # the call snapshot so the pipeline re-resolves (and re-decrypts) per call.
    tool_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(UUID(as_uuid=True)), nullable=False, server_default=text("'{}'")
    )
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()

    __table_args__ = (Index("ix_agents_tenant_id", "tenant_id"),)


class CustomTool(Base):
    """A tenant-defined HTTP tool the LLM can call during a call.

    The LLM sees ``name``/``description``/``parameters`` (a JSON-Schema of the
    arguments). When called, the platform issues an HTTP request to ``url`` with
    the model's arguments and returns the response to the model. ``headers`` are
    encrypted (they typically carry the tenant's API auth) exactly like a
    connection's secrets — AAD-bound to tenant_id|tool_id|"tool".
    """

    __tablename__ = "custom_tools"

    id: Mapped[uuid.UUID] = _uuid_pk()
    tenant_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    # Function name the LLM calls. Valid identifier, unique per tenant.
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    # JSON-Schema-ish arg spec: {"properties": {...}, "required": [...]}.
    parameters: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    method: Mapped[str] = mapped_column(String(8), nullable=False, default="GET")
    url: Mapped[str] = mapped_column(Text, nullable=False)
    # Encrypted static headers (e.g. Authorization). Null when no auth headers.
    headers_ciphertext: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    headers_nonce: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    timeout_seconds: Mapped[int] = mapped_column(nullable=False, default=10, server_default=text("10"))
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()

    __table_args__ = (
        UniqueConstraint("tenant_id", "name", name="uq_custom_tools_tenant_name"),
        Index("ix_custom_tools_tenant_id", "tenant_id"),
    )


class Call(Base):
    __tablename__ = "calls"

    id: Mapped[uuid.UUID] = _uuid_pk()
    tenant_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    agent_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agents.id", ondelete="SET NULL"), nullable=True
    )
    direction: Mapped[str] = mapped_column(String(16), nullable=False)  # outbound/web
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="reserved")
    to_number: Mapped[str | None] = mapped_column(String(32), nullable=True)
    from_number: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # User-supplied key/value labels for filtering the activity feed, e.g.
    # {"region": "North", "motive": "sales"}. Searched with JSONB containment
    # (@>) backed by the GIN index below.
    tags: Mapped[dict] = mapped_column(
        JSONB, nullable=False, default=dict, server_default=text("'{}'::jsonb")
    )
    provider_call_id: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Opaque single-use token the carrier webhook/WS presents (carrier auth).
    session_token: Mapped[str | None] = mapped_column(Text, nullable=True, unique=True)
    session_consumed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # Frozen {agent, context, metadata} resolved at reserve time (replaces the
    # old in-memory session store). Secrets are NOT included here.
    call_context_snapshot: Mapped[dict] = mapped_column(JSONB, nullable=False)
    outcome: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Structured failure code (carrier_error / no_answer / config_error / pipeline_error / ...).
    error_code: Mapped[str | None] = mapped_column(String(48), nullable=True)
    # Full conversation content: [{role, text, t}] (call "content"; SendGrid analogue).
    transcript: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    # Path/key to the call's audio recording (mixed WAV), if captured.
    recording_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = _created()
    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    ended_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    __table_args__ = (
        Index("ix_calls_tenant_created", "tenant_id", "created_at"),
        # Activity-feed filters.
        Index("ix_calls_tenant_status", "tenant_id", "status"),
        # Tag search: JSONB containment (tags @> '{"region":"North"}').
        Index("ix_calls_tags_gin", "tags", postgresql_using="gin"),
    )


class CallEvent(Base):
    """Append-only per-call event timeline — the raw, auditable call log."""

    __tablename__ = "call_events"

    id: Mapped[uuid.UUID] = _uuid_pk()
    tenant_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    call_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("calls.id", ondelete="CASCADE"), nullable=False
    )
    type: Mapped[str] = mapped_column(String(48), nullable=False)  # call.queued, call.failed, carrier.hangup, ...
    data: Mapped[dict] = mapped_column(JSONB, nullable=False, default=dict)
    error_code: Mapped[str | None] = mapped_column(String(48), nullable=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("ix_call_events_call_ts", "call_id", "ts"),
        Index("ix_call_events_tenant_ts", "tenant_id", "ts"),
    )


class CallJob(Base):
    """Outbound-dial work queue. Worker claims with FOR UPDATE SKIP LOCKED."""

    __tablename__ = "call_jobs"

    id: Mapped[uuid.UUID] = _uuid_pk()
    tenant_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    call_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("calls.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(String(24), nullable=False, default="dial")
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="queued")  # queued/done/failed
    run_after: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    leased_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    attempts: Mapped[int] = mapped_column(nullable=False, default=0)
    max_attempts: Mapped[int] = mapped_column(nullable=False, default=5)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()

    __table_args__ = (
        Index("ix_call_jobs_claim", "status", "run_after"),
    )


class WebhookEndpoint(Base):
    """A tenant's webhook destination. Signing secret is encrypted at rest."""

    __tablename__ = "webhook_endpoints"

    id: Mapped[uuid.UUID] = _uuid_pk()
    tenant_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    url: Mapped[str] = mapped_column(Text, nullable=False)
    # HMAC signing secret, AES-GCM encrypted (tenant DEK), AAD provider_name="webhook".
    secret_ciphertext: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    secret_nonce: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    # Subscribed events; empty = all.
    events: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    enabled: Mapped[bool] = mapped_column(nullable=False, default=True)
    created_at: Mapped[datetime] = _created()

    __table_args__ = (Index("ix_webhook_endpoints_tenant", "tenant_id"),)


class WebhookDelivery(Base):
    """One pending/attempted webhook delivery. Worker claims with SKIP LOCKED."""

    __tablename__ = "webhook_deliveries"

    id: Mapped[uuid.UUID] = _uuid_pk()
    tenant_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    endpoint_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("webhook_endpoints.id", ondelete="CASCADE"), nullable=False
    )
    call_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("calls.id", ondelete="SET NULL"), nullable=True
    )
    event: Mapped[str] = mapped_column(String(48), nullable=False)
    payload: Mapped[dict] = mapped_column(JSONB, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="queued")  # queued/delivered/failed
    run_after: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    leased_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    attempts: Mapped[int] = mapped_column(nullable=False, default=0)
    max_attempts: Mapped[int] = mapped_column(nullable=False, default=8)
    response_code: Mapped[int | None] = mapped_column(nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()

    __table_args__ = (
        Index("ix_webhook_deliveries_claim", "status", "run_after"),
    )


class RateLimitCounter(Base):
    """Fixed-window per-tenant request counter (one row per tenant per minute)."""

    __tablename__ = "rate_limit_counters"

    tenant_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), primary_key=True
    )
    window_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    count: Mapped[int] = mapped_column(nullable=False, default=0)


class UsageRecord(Base):
    """One metered usage event (e.g. a completed call's billable seconds)."""

    __tablename__ = "usage_records"

    id: Mapped[uuid.UUID] = _uuid_pk()
    tenant_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    call_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("calls.id", ondelete="SET NULL"), nullable=True
    )
    kind: Mapped[str] = mapped_column(String(24), nullable=False, default="call")
    seconds: Mapped[int] = mapped_column(nullable=False, default=0)
    created_at: Mapped[datetime] = _created()

    __table_args__ = (Index("ix_usage_tenant_created", "tenant_id", "created_at"),)


class PhoneNumber(Base):
    """An inbound number routed to one of the tenant's agents."""

    __tablename__ = "phone_numbers"

    id: Mapped[uuid.UUID] = _uuid_pk()
    tenant_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    e164: Mapped[str] = mapped_column(String(32), nullable=False, unique=True)
    agent_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("agents.id", ondelete="CASCADE"), nullable=False
    )
    created_at: Mapped[datetime] = _created()

    __table_args__ = (Index("ix_phone_numbers_tenant", "tenant_id"),)


class IdempotencyKey(Base):
    """Cached responses for client-supplied Idempotency-Key (load-bearing in P2)."""

    __tablename__ = "idempotency_keys"

    id: Mapped[uuid.UUID] = _uuid_pk()
    tenant_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False
    )
    key: Mapped[str] = mapped_column(Text, nullable=False)
    request_hash: Mapped[str] = mapped_column(Text, nullable=False)
    response_code: Mapped[int | None] = mapped_column(nullable=True)
    response_body: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    created_at: Mapped[datetime] = _created()

    __table_args__ = (
        UniqueConstraint("tenant_id", "key", name="uq_idempotency_tenant_key"),
    )
