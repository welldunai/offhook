"""Agents API — reusable agent definitions referencing the tenant's connections."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.schemas import AgentCreate, AgentOut
from app.auth.dependencies import TenantContext, require_tenant
from app.db import repositories as repo
from app.db.engine import get_session
from app.db.models import Agent

router = APIRouter(prefix="/agents", tags=["agents"])


def _out(a: Agent) -> AgentOut:
    return AgentOut.model_validate(a, from_attributes=True)


async def _validate_connection(
    db: AsyncSession, tenant_id: uuid.UUID, conn_id: uuid.UUID | None, kind: str
) -> None:
    if conn_id is None:
        return
    conn = await repo.get_connection(db, tenant_id, conn_id)
    if conn is None:
        raise HTTPException(status_code=422, detail=f"{kind} connection not found")
    if conn.provider_kind != kind:
        raise HTTPException(
            status_code=422, detail=f"connection {conn.name!r} is not a {kind} connection"
        )


@router.post("", response_model=AgentOut, status_code=201)
async def create_agent(
    body: AgentCreate,
    ctx: TenantContext = Depends(require_tenant),
    db: AsyncSession = Depends(get_session),
) -> AgentOut:
    await _validate_connection(db, ctx.tenant_id, body.stt_connection_id, "stt")
    await _validate_connection(db, ctx.tenant_id, body.tts_connection_id, "tts")
    await _validate_connection(db, ctx.tenant_id, body.llm_connection_id, "llm")
    await _validate_connection(db, ctx.tenant_id, body.telephony_connection_id, "telephony")

    # Every referenced tool must belong to this tenant.
    if body.tool_ids:
        found = await repo.get_custom_tools_by_ids(db, ctx.tenant_id, body.tool_ids)
        if len(found) != len(set(body.tool_ids)):
            raise HTTPException(status_code=422, detail="one or more tool_ids not found")

    agent = Agent(tenant_id=ctx.tenant_id, **body.model_dump())
    db.add(agent)
    await db.flush()
    return _out(agent)


@router.get("", response_model=list[AgentOut])
async def list_agents(
    ctx: TenantContext = Depends(require_tenant),
    db: AsyncSession = Depends(get_session),
) -> list[AgentOut]:
    return [_out(a) for a in await repo.list_agents(db, ctx.tenant_id)]


@router.get("/{agent_id}", response_model=AgentOut)
async def get_agent(
    agent_id: uuid.UUID,
    ctx: TenantContext = Depends(require_tenant),
    db: AsyncSession = Depends(get_session),
) -> AgentOut:
    agent = await repo.get_agent(db, ctx.tenant_id, agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail="agent not found")
    return _out(agent)


@router.delete("/{agent_id}", status_code=204)
async def delete_agent(
    agent_id: uuid.UUID,
    ctx: TenantContext = Depends(require_tenant),
    db: AsyncSession = Depends(get_session),
) -> None:
    agent = await repo.get_agent(db, ctx.tenant_id, agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail="agent not found")
    await db.delete(agent)
    await db.flush()
