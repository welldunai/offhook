"""Map a Clerk user to a tenant, auto-provisioning a workspace on first login.

Each Clerk user gets their own tenant (a personal workspace) the first time
they sign in. Multi-user tenants / invites can layer on later — the ``users``
table already separates the human identity from the tenant.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Tenant, User


@dataclass(frozen=True)
class ResolvedUser:
    tenant_id: uuid.UUID
    user_id: uuid.UUID
    email: str | None
    rate_limit_per_min: int


def _slug(seed: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", (seed or "user").lower()).strip("-")[:24] or "user"
    return f"{base}-{uuid.uuid4().hex[:6]}"


async def resolve_or_provision(
    db: AsyncSession, clerk_user_id: str, email: str | None
) -> ResolvedUser:
    user = (
        await db.execute(select(User).where(User.clerk_user_id == clerk_user_id))
    ).scalar_one_or_none()
    if user is not None:
        tenant = await db.get(Tenant, user.tenant_id)
        return ResolvedUser(tenant.id, user.id, user.email, tenant.rate_limit_per_min)

    # First login → create a workspace + user.
    tenant = Tenant(name=email or "Workspace", slug=_slug(email or clerk_user_id))
    db.add(tenant)
    await db.flush()
    user = User(clerk_user_id=clerk_user_id, tenant_id=tenant.id, email=email)
    db.add(user)
    try:
        await db.flush()
    except IntegrityError:
        # A concurrent first request won the race — use the existing row.
        await db.rollback()
        user = (
            await db.execute(select(User).where(User.clerk_user_id == clerk_user_id))
        ).scalar_one()
        tenant = await db.get(Tenant, user.tenant_id)
    return ResolvedUser(tenant.id, user.id, user.email, tenant.rate_limit_per_min)
