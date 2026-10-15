"""Tenant-scoped data access.

Every method that touches tenant data takes ``tenant_id`` as its first argument
and filters by it. This is the single chokepoint that makes cross-tenant access
structurally hard: routes never write raw queries, they call these helpers.

These return ORM rows; encryption/decryption of connection secrets lives in
``app/crypto`` and is invoked by ``app/tenancy/resolve.py`` and the connections
API — repositories deal only in ciphertext.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import (
    Agent,
    ApiKey,
    Call,
    Connection,
    CustomTool,
    IdempotencyKey,
    PhoneNumber,
    Tenant,
    TenantKey,
)


# ---- tenants -------------------------------------------------------------


async def get_tenant(db: AsyncSession, tenant_id: uuid.UUID) -> Tenant | None:
    return await db.get(Tenant, tenant_id)


async def get_tenant_by_slug(db: AsyncSession, slug: str) -> Tenant | None:
    return (
        await db.execute(select(Tenant).where(Tenant.slug == slug))
    ).scalar_one_or_none()


# ---- api keys ------------------------------------------------------------


async def get_active_api_key_by_prefix(db: AsyncSession, prefix: str) -> ApiKey | None:
    return (
        await db.execute(
            select(ApiKey).where(ApiKey.prefix == prefix, ApiKey.revoked_at.is_(None))
        )
    ).scalar_one_or_none()


async def touch_api_key(db: AsyncSession, api_key_id: uuid.UUID) -> None:
    await db.execute(
        update(ApiKey)
        .where(ApiKey.id == api_key_id)
        .values(last_used_at=datetime.now(timezone.utc))
    )


async def list_api_keys(db: AsyncSession, tenant_id: uuid.UUID) -> list[ApiKey]:
    return list(
        (
            await db.execute(select(ApiKey).where(ApiKey.tenant_id == tenant_id))
        ).scalars()
    )


async def revoke_api_key(
    db: AsyncSession, tenant_id: uuid.UUID, api_key_id: uuid.UUID
) -> bool:
    res = await db.execute(
        update(ApiKey)
        .where(ApiKey.id == api_key_id, ApiKey.tenant_id == tenant_id, ApiKey.revoked_at.is_(None))
        .values(revoked_at=datetime.now(timezone.utc))
    )
    return res.rowcount > 0


# ---- tenant keys (DEK) ---------------------------------------------------


async def get_tenant_key(db: AsyncSession, tenant_id: uuid.UUID) -> TenantKey | None:
    return await db.get(TenantKey, tenant_id)


# ---- connections ---------------------------------------------------------


async def get_connection(
    db: AsyncSession, tenant_id: uuid.UUID, connection_id: uuid.UUID
) -> Connection | None:
    return (
        await db.execute(
            select(Connection).where(
                Connection.id == connection_id, Connection.tenant_id == tenant_id
            )
        )
    ).scalar_one_or_none()


async def list_connections(db: AsyncSession, tenant_id: uuid.UUID) -> list[Connection]:
    return list(
        (
            await db.execute(
                select(Connection).where(Connection.tenant_id == tenant_id)
            )
        ).scalars()
    )


# ---- agents --------------------------------------------------------------


async def get_agent(
    db: AsyncSession, tenant_id: uuid.UUID, agent_id: uuid.UUID
) -> Agent | None:
    return (
        await db.execute(
            select(Agent).where(Agent.id == agent_id, Agent.tenant_id == tenant_id)
        )
    ).scalar_one_or_none()


async def list_agents(db: AsyncSession, tenant_id: uuid.UUID) -> list[Agent]:
    return list(
        (await db.execute(select(Agent).where(Agent.tenant_id == tenant_id))).scalars()
    )


# ---- custom tools --------------------------------------------------------


async def get_custom_tool(
    db: AsyncSession, tenant_id: uuid.UUID, tool_id: uuid.UUID
) -> CustomTool | None:
    return (
        await db.execute(
            select(CustomTool).where(
                CustomTool.id == tool_id, CustomTool.tenant_id == tenant_id
            )
        )
    ).scalar_one_or_none()


async def list_custom_tools(db: AsyncSession, tenant_id: uuid.UUID) -> list[CustomTool]:
    return list(
        (
            await db.execute(
                select(CustomTool).where(CustomTool.tenant_id == tenant_id)
            )
        ).scalars()
    )


async def get_custom_tools_by_ids(
    db: AsyncSession, tenant_id: uuid.UUID, tool_ids: list[uuid.UUID]
) -> list[CustomTool]:
    """Load the named tools (tenant-scoped), preserving ``tool_ids`` order."""
    if not tool_ids:
        return []
    rows = list(
        (
            await db.execute(
                select(CustomTool).where(
                    CustomTool.tenant_id == tenant_id, CustomTool.id.in_(tool_ids)
                )
            )
        ).scalars()
    )
    by_id = {row.id: row for row in rows}
    return [by_id[tid] for tid in tool_ids if tid in by_id]


# ---- calls ---------------------------------------------------------------


async def get_call(
    db: AsyncSession, tenant_id: uuid.UUID, call_id: uuid.UUID
) -> Call | None:
    return (
        await db.execute(
            select(Call).where(Call.id == call_id, Call.tenant_id == tenant_id)
        )
    ).scalar_one_or_none()


async def count_active_calls(db: AsyncSession, tenant_id: uuid.UUID) -> int:
    """Calls currently occupying a concurrency slot."""
    return (
        await db.execute(
            select(func.count())
            .select_from(Call)
            .where(Call.tenant_id == tenant_id, Call.status.in_(("queued", "dialing", "in_progress")))
        )
    ).scalar_one()


async def count_calls_this_month(db: AsyncSession, tenant_id: uuid.UUID) -> int:
    return (
        await db.execute(
            select(func.count())
            .select_from(Call)
            .where(Call.tenant_id == tenant_id, Call.created_at >= func.date_trunc("month", func.now()))
        )
    ).scalar_one()


async def get_call_by_session_token(db: AsyncSession, token: str) -> Call | None:
    """Carrier-facing lookup: NOT tenant-scoped (carrier has no tenant), but the
    token is high-entropy and single-use; the call row carries its own tenant_id."""
    return (
        await db.execute(select(Call).where(Call.session_token == token))
    ).scalar_one_or_none()


async def get_phone_number_by_e164(db: AsyncSession, e164: str) -> PhoneNumber | None:
    """Inbound routing lookup (not tenant-scoped; the number maps to a tenant)."""
    return (
        await db.execute(select(PhoneNumber).where(PhoneNumber.e164 == e164))
    ).scalar_one_or_none()


# ---- idempotency ---------------------------------------------------------


async def get_idempotency(db: AsyncSession, tenant_id: uuid.UUID, key: str) -> IdempotencyKey | None:
    return (
        await db.execute(
            select(IdempotencyKey).where(
                IdempotencyKey.tenant_id == tenant_id, IdempotencyKey.key == key
            )
        )
    ).scalar_one_or_none()
