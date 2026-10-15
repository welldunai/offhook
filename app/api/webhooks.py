"""Webhook endpoints API.

A tenant registers URLs to receive signed event callbacks. The signing secret
is generated server-side, returned exactly once at creation, and stored
encrypted (per-tenant DEK). URLs are SSRF-validated at write time.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import TenantContext, require_tenant
from app.crypto.envelope import encrypt_secret, get_or_create_tenant_dek
from app.db.engine import get_session
from app.db.models import WebhookEndpoint
from app.security.ssrf import UnsafeURLError, validate_public_url
from app.settings import settings
from app.webhooks.signing import generate_secret
from pydantic import BaseModel, Field
from datetime import datetime

router = APIRouter(prefix="/webhooks", tags=["webhooks"])


class WebhookCreate(BaseModel):
    url: str
    events: list[str] = Field(default_factory=list)  # empty = all


class WebhookCreated(BaseModel):
    id: uuid.UUID
    url: str
    events: list[str]
    enabled: bool
    secret: str  # shown once
    created_at: datetime


class WebhookOut(BaseModel):
    id: uuid.UUID
    url: str
    events: list[str]
    enabled: bool
    created_at: datetime


@router.post("", response_model=WebhookCreated, status_code=201)
async def create_webhook(
    body: WebhookCreate,
    ctx: TenantContext = Depends(require_tenant),
    db: AsyncSession = Depends(get_session),
) -> WebhookCreated:
    try:
        validate_public_url(body.url, allow_private=settings.webhook_allow_private)
    except UnsafeURLError as exc:
        raise HTTPException(status_code=422, detail=f"invalid url: {exc}")

    ep_id = uuid.uuid4()
    secret = generate_secret()
    dek = await get_or_create_tenant_dek(db, ctx.tenant_id)
    ct, nonce = encrypt_secret(
        dek, {"secret": secret}, tenant_id=ctx.tenant_id,
        connection_id=ep_id, provider_name="webhook",
    )
    ep = WebhookEndpoint(
        id=ep_id, tenant_id=ctx.tenant_id, url=body.url, events=body.events,
        secret_ciphertext=ct, secret_nonce=nonce,
    )
    db.add(ep)
    await db.flush()
    return WebhookCreated(
        id=ep.id, url=ep.url, events=ep.events, enabled=ep.enabled,
        secret=secret, created_at=ep.created_at,
    )


@router.get("", response_model=list[WebhookOut])
async def list_webhooks(
    ctx: TenantContext = Depends(require_tenant),
    db: AsyncSession = Depends(get_session),
) -> list[WebhookOut]:
    rows = (
        await db.execute(
            select(WebhookEndpoint).where(WebhookEndpoint.tenant_id == ctx.tenant_id)
        )
    ).scalars()
    return [WebhookOut.model_validate(r, from_attributes=True) for r in rows]


@router.delete("/{webhook_id}", status_code=204)
async def delete_webhook(
    webhook_id: uuid.UUID,
    ctx: TenantContext = Depends(require_tenant),
    db: AsyncSession = Depends(get_session),
) -> None:
    ep = (
        await db.execute(
            select(WebhookEndpoint).where(
                WebhookEndpoint.id == webhook_id, WebhookEndpoint.tenant_id == ctx.tenant_id
            )
        )
    ).scalar_one_or_none()
    if ep is None:
        raise HTTPException(status_code=404, detail="webhook not found")
    await db.delete(ep)
    await db.flush()
