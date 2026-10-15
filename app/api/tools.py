"""Custom tools API — tenant-defined HTTP functions the LLM can call mid-call.

A tool declares a name + description + argument schema (what the model sees) and
an HTTP endpoint to hit. The endpoint URL is SSRF-validated on write, and any
auth headers are encrypted at rest (per-tenant DEK, AAD-bound to the row) exactly
like a connection's secrets — header values are never returned on any response.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.schemas import ToolCreate, ToolOut, ToolUpdate
from app.auth.dependencies import TenantContext, require_tenant
from app.crypto.envelope import encrypt_secret, get_or_create_tenant_dek
from app.db import repositories as repo
from app.db.engine import get_session
from app.db.models import CustomTool
from app.security.ssrf import UnsafeURLError, validate_public_url

router = APIRouter(prefix="/tools", tags=["tools"])


def _validate_url(url: str) -> None:
    try:
        validate_public_url(url)
    except UnsafeURLError as exc:
        raise HTTPException(status_code=422, detail=f"invalid tool URL: {exc}")


def _out(t: CustomTool) -> ToolOut:
    return ToolOut(
        id=t.id, name=t.name, description=t.description, parameters=t.parameters,
        method=t.method, url=t.url, has_auth=t.headers_ciphertext is not None,
        timeout_seconds=t.timeout_seconds, created_at=t.created_at,
    )


async def _encrypt_headers(
    db: AsyncSession, tenant_id: uuid.UUID, tool_id: uuid.UUID, headers: dict
) -> tuple[bytes | None, bytes | None]:
    if not headers:
        return None, None
    dek = await get_or_create_tenant_dek(db, tenant_id)
    return encrypt_secret(
        dek, headers, tenant_id=tenant_id, connection_id=tool_id, provider_name="tool"
    )


@router.post("", response_model=ToolOut, status_code=201)
async def create_tool(
    body: ToolCreate,
    ctx: TenantContext = Depends(require_tenant),
    db: AsyncSession = Depends(get_session),
) -> ToolOut:
    _validate_url(body.url)

    tool_id = uuid.uuid4()  # needed for header AAD before insert
    ciphertext, nonce = await _encrypt_headers(db, ctx.tenant_id, tool_id, body.headers)
    tool = CustomTool(
        id=tool_id, tenant_id=ctx.tenant_id, name=body.name,
        description=body.description, parameters=body.parameters,
        method=body.method, url=body.url,
        headers_ciphertext=ciphertext, headers_nonce=nonce,
        timeout_seconds=body.timeout_seconds,
    )
    db.add(tool)
    try:
        await db.flush()
    except IntegrityError:
        raise HTTPException(status_code=409, detail="tool name already exists")
    return _out(tool)


@router.get("", response_model=list[ToolOut])
async def list_tools(
    ctx: TenantContext = Depends(require_tenant),
    db: AsyncSession = Depends(get_session),
) -> list[ToolOut]:
    return [_out(t) for t in await repo.list_custom_tools(db, ctx.tenant_id)]


@router.get("/{tool_id}", response_model=ToolOut)
async def get_tool(
    tool_id: uuid.UUID,
    ctx: TenantContext = Depends(require_tenant),
    db: AsyncSession = Depends(get_session),
) -> ToolOut:
    tool = await repo.get_custom_tool(db, ctx.tenant_id, tool_id)
    if tool is None:
        raise HTTPException(status_code=404, detail="tool not found")
    return _out(tool)


@router.patch("/{tool_id}", response_model=ToolOut)
async def update_tool(
    tool_id: uuid.UUID,
    body: ToolUpdate,
    ctx: TenantContext = Depends(require_tenant),
    db: AsyncSession = Depends(get_session),
) -> ToolOut:
    tool = await repo.get_custom_tool(db, ctx.tenant_id, tool_id)
    if tool is None:
        raise HTTPException(status_code=404, detail="tool not found")

    if body.description is not None:
        tool.description = body.description
    if body.parameters is not None:
        tool.parameters = body.parameters
    if body.method is not None:
        tool.method = body.method
    if body.url is not None:
        _validate_url(body.url)
        tool.url = body.url
    if body.timeout_seconds is not None:
        tool.timeout_seconds = body.timeout_seconds
    if body.headers is not None:
        # Empty dict clears auth; otherwise re-encrypt.
        tool.headers_ciphertext, tool.headers_nonce = await _encrypt_headers(
            db, ctx.tenant_id, tool.id, body.headers
        )
    await db.flush()
    return _out(tool)


@router.delete("/{tool_id}", status_code=204)
async def delete_tool(
    tool_id: uuid.UUID,
    ctx: TenantContext = Depends(require_tenant),
    db: AsyncSession = Depends(get_session),
) -> None:
    tool = await repo.get_custom_tool(db, ctx.tenant_id, tool_id)
    if tool is None:
        raise HTTPException(status_code=404, detail="tool not found")
    await db.delete(tool)
    await db.flush()
