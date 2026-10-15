"""Connections API — tenant's stored, encrypted provider credentials.

Secrets are encrypted on write (per-tenant DEK, AAD-bound to the row) and never
returned. Provider names are validated against the locked supported list.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.schemas import ConnectionCreate, ConnectionOut, ConnectionUpdate
from app.auth.dependencies import TenantContext, require_tenant
from app.config import SUPPORTED_PROVIDERS
from app.crypto.envelope import encrypt_secret, get_or_create_tenant_dek
from app.db import repositories as repo
from app.db.engine import get_session
from app.db.models import Connection

router = APIRouter(prefix="/connections", tags=["connections"])


def _validate_provider(kind: str, name: str) -> None:
    if name not in SUPPORTED_PROVIDERS.get(kind, set()):
        raise HTTPException(
            status_code=422,
            detail=f"unsupported {kind} provider {name!r}; allowed: "
            f"{sorted(SUPPORTED_PROVIDERS.get(kind, set()))}",
        )


def _out(c: Connection) -> ConnectionOut:
    return ConnectionOut(
        id=c.id, name=c.name, provider_kind=c.provider_kind,
        provider_name=c.provider_name, created_at=c.created_at,
    )


@router.post("", response_model=ConnectionOut, status_code=201)
async def create_connection(
    body: ConnectionCreate,
    ctx: TenantContext = Depends(require_tenant),
    db: AsyncSession = Depends(get_session),
) -> ConnectionOut:
    _validate_provider(body.provider_kind, body.provider_name)

    conn_id = uuid.uuid4()  # needed for AAD before insert
    dek = await get_or_create_tenant_dek(db, ctx.tenant_id)
    ciphertext, nonce = encrypt_secret(
        dek, body.secrets, tenant_id=ctx.tenant_id,
        connection_id=conn_id, provider_name=body.provider_name,
    )
    conn = Connection(
        id=conn_id, tenant_id=ctx.tenant_id, name=body.name,
        provider_kind=body.provider_kind, provider_name=body.provider_name,
        ciphertext=ciphertext, nonce=nonce,
    )
    db.add(conn)
    try:
        await db.flush()
    except IntegrityError:
        raise HTTPException(status_code=409, detail="connection name already exists")
    return _out(conn)


@router.get("", response_model=list[ConnectionOut])
async def list_connections(
    ctx: TenantContext = Depends(require_tenant),
    db: AsyncSession = Depends(get_session),
) -> list[ConnectionOut]:
    return [_out(c) for c in await repo.list_connections(db, ctx.tenant_id)]


@router.get("/{connection_id}", response_model=ConnectionOut)
async def get_connection(
    connection_id: uuid.UUID,
    ctx: TenantContext = Depends(require_tenant),
    db: AsyncSession = Depends(get_session),
) -> ConnectionOut:
    conn = await repo.get_connection(db, ctx.tenant_id, connection_id)
    if conn is None:
        raise HTTPException(status_code=404, detail="connection not found")
    return _out(conn)


@router.patch("/{connection_id}", response_model=ConnectionOut)
async def update_connection(
    connection_id: uuid.UUID,
    body: ConnectionUpdate,
    ctx: TenantContext = Depends(require_tenant),
    db: AsyncSession = Depends(get_session),
) -> ConnectionOut:
    conn = await repo.get_connection(db, ctx.tenant_id, connection_id)
    if conn is None:
        raise HTTPException(status_code=404, detail="connection not found")
    if body.name is not None:
        conn.name = body.name
    if body.secrets is not None:
        dek = await get_or_create_tenant_dek(db, ctx.tenant_id)
        conn.ciphertext, conn.nonce = encrypt_secret(
            dek, body.secrets, tenant_id=ctx.tenant_id,
            connection_id=conn.id, provider_name=conn.provider_name,
        )
    await db.flush()
    return _out(conn)


@router.delete("/{connection_id}", status_code=204)
async def delete_connection(
    connection_id: uuid.UUID,
    ctx: TenantContext = Depends(require_tenant),
    db: AsyncSession = Depends(get_session),
) -> None:
    conn = await repo.get_connection(db, ctx.tenant_id, connection_id)
    if conn is None:
        raise HTTPException(status_code=404, detail="connection not found")
    await db.delete(conn)
    try:
        await db.flush()
    except IntegrityError:
        raise HTTPException(status_code=409, detail="connection is in use by an agent")
