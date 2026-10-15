"""FastAPI auth dependencies.

``require_tenant`` guards every tenant-facing ``/v1`` route (mounted at the
router level so a route can't forget it). ``require_call_session`` guards the
carrier-facing webhook/websocket, which is hit by the telephony provider (no
API key) — it authenticates via the single-use ``session_token`` minted when
the call was placed.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import Depends, Header, HTTPException, Request, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.apikey import parse_key, spend_dummy_verify, verify_secret
from app.auth.clerk import ClerkError, claims_to_identity, verify_clerk_jwt
from app.db import repositories as repo
from app.db.engine import get_session
from app.db.models import Call
from app.settings import settings
from app.tenancy.users import resolve_or_provision


@dataclass(frozen=True)
class TenantContext:
    tenant_id: uuid.UUID
    #: Set when authenticated by API key; None for a dashboard user session.
    api_key_id: uuid.UUID | None = None
    #: Set when authenticated by a Clerk user session; None for API keys.
    user_id: uuid.UUID | None = None
    email: str | None = None
    principal: str = "api_key"  # "api_key" | "user"
    rate_limit_per_min: int = 120


_UNAUTHED = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Invalid or missing credentials",
    headers={"WWW-Authenticate": "Bearer"},
)


def _extract_key(authorization: str | None, x_api_key: str | None) -> str | None:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    if x_api_key:
        return x_api_key.strip()
    return None


async def _scope_rls(db: AsyncSession, tenant_id: uuid.UUID) -> None:
    # Defense-in-depth: scope this transaction's RLS to the tenant (no-op unless
    # the RLS policies are installed; see app/db/rls.sql).
    if settings.enable_rls:
        await db.execute(
            text("SELECT set_config('app.current_tenant', :t, true)"), {"t": str(tenant_id)}
        )


async def _from_api_key(request: Request, presented: str, db: AsyncSession) -> TenantContext:
    parsed = parse_key(presented)
    if parsed is None:
        spend_dummy_verify()
        raise _UNAUTHED
    prefix, secret = parsed
    api_key = await repo.get_active_api_key_by_prefix(db, prefix)
    if api_key is None:
        spend_dummy_verify()  # uniform timing for unknown prefix
        raise _UNAUTHED
    if not verify_secret(api_key.key_hash, secret):
        raise _UNAUTHED
    if api_key.expires_at is not None and api_key.expires_at < datetime.now(timezone.utc):
        raise HTTPException(status_code=401, detail="API key expired")

    tenant = await repo.get_tenant(db, api_key.tenant_id)
    if tenant is None or tenant.status != "active":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Tenant inactive")

    await repo.touch_api_key(db, api_key.id)
    await _scope_rls(db, tenant.id)
    ctx = TenantContext(
        tenant_id=tenant.id, api_key_id=api_key.id, principal="api_key",
        rate_limit_per_min=tenant.rate_limit_per_min,
    )
    request.state.tenant = ctx
    return ctx


async def _from_clerk(request: Request, token: str, db: AsyncSession) -> TenantContext:
    if not settings.clerk_enabled:
        raise _UNAUTHED
    try:
        claims = verify_clerk_jwt(token)
    except ClerkError:
        raise _UNAUTHED
    clerk_user_id, email = claims_to_identity(claims)
    resolved = await resolve_or_provision(db, clerk_user_id, email)
    await _scope_rls(db, resolved.tenant_id)
    ctx = TenantContext(
        tenant_id=resolved.tenant_id, user_id=resolved.user_id, email=resolved.email,
        principal="user", rate_limit_per_min=resolved.rate_limit_per_min,
    )
    request.state.tenant = ctx
    return ctx


async def require_tenant(
    request: Request,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
    db: AsyncSession = Depends(get_session),
) -> TenantContext:
    """Authenticate by API key (``vk_…``) or a Clerk user session JWT; both
    resolve to a tenant."""
    presented = _extract_key(authorization, x_api_key)
    if not presented:
        spend_dummy_verify()
        raise _UNAUTHED
    if presented.startswith("vk_"):
        return await _from_api_key(request, presented, db)
    return await _from_clerk(request, presented, db)


async def enforce_rate_limit(
    ctx: TenantContext = Depends(require_tenant),
    db: AsyncSession = Depends(get_session),
) -> None:
    """Per-tenant fixed-window API rate limit. 429 over the tenant's limit."""
    from app.ratelimit import hit

    allowed, count = await hit(db, ctx.tenant_id, ctx.rate_limit_per_min)
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="rate limit exceeded",
            headers={"Retry-After": "60"},
        )


async def require_call_session(
    session_token: str | None = None,
    db: AsyncSession = Depends(get_session),
) -> Call:
    """Resolve + consume the carrier session token. Single-use.

    Returns the matching ``Call`` (which carries its own ``tenant_id``). Rejects
    missing/unknown/already-consumed tokens.
    """
    if not session_token:
        raise HTTPException(status_code=403, detail="Missing session token")
    call = await repo.get_call_by_session_token(db, session_token)
    if call is None or call.session_consumed_at is not None:
        raise HTTPException(status_code=403, detail="Invalid or used session token")
    call.session_consumed_at = datetime.now(timezone.utc)
    await db.flush()
    return call
