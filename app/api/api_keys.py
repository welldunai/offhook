"""API keys API — issue/list/revoke a tenant's keys.

The full key is returned exactly once at creation; afterward only metadata
(prefix, name, usage, revocation) is retrievable.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.schemas import ApiKeyCreate, ApiKeyCreated, ApiKeyOut
from app.auth.apikey import generate_key
from app.auth.dependencies import TenantContext, require_tenant
from app.db import repositories as repo
from app.db.engine import get_session
from app.db.models import ApiKey

router = APIRouter(prefix="/api-keys", tags=["api-keys"])


@router.post("", response_model=ApiKeyCreated, status_code=201)
async def create_api_key(
    body: ApiKeyCreate,
    ctx: TenantContext = Depends(require_tenant),
    db: AsyncSession = Depends(get_session),
) -> ApiKeyCreated:
    expires_at = None
    if body.expires_in_days:
        expires_at = datetime.now(timezone.utc) + timedelta(days=body.expires_in_days)
    gen = generate_key()
    key = ApiKey(
        tenant_id=ctx.tenant_id, prefix=gen.prefix, key_hash=gen.key_hash,
        name=body.name, expires_at=expires_at,
    )
    db.add(key)
    await db.flush()
    return ApiKeyCreated(
        id=key.id, prefix=key.prefix, key=gen.full_key,
        expires_at=key.expires_at, created_at=key.created_at,
    )


@router.get("", response_model=list[ApiKeyOut])
async def list_api_keys(
    ctx: TenantContext = Depends(require_tenant),
    db: AsyncSession = Depends(get_session),
) -> list[ApiKeyOut]:
    return [ApiKeyOut.model_validate(k, from_attributes=True) for k in await repo.list_api_keys(db, ctx.tenant_id)]


@router.delete("/{api_key_id}", status_code=204)
async def revoke_api_key(
    api_key_id: uuid.UUID,
    ctx: TenantContext = Depends(require_tenant),
    db: AsyncSession = Depends(get_session),
) -> None:
    if not await repo.revoke_api_key(db, ctx.tenant_id, api_key_id):
        raise HTTPException(status_code=404, detail="api key not found or already revoked")
