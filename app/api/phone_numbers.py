"""Phone numbers API — map an inbound E.164 number to one of the tenant's agents.

When a call arrives on a Plivo number whose answer URL points at
``/v1/telephony/inbound``, we look the number up here to find the agent that
should handle it.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import TenantContext, require_tenant
from app.db import repositories as repo
from app.db.engine import get_session
from app.db.models import PhoneNumber

router = APIRouter(prefix="/phone-numbers", tags=["phone-numbers"])


class PhoneNumberCreate(BaseModel):
    e164: str = Field(min_length=3, max_length=32)
    agent_id: uuid.UUID


class PhoneNumberOut(BaseModel):
    id: uuid.UUID
    e164: str
    agent_id: uuid.UUID
    created_at: datetime


@router.post("", response_model=PhoneNumberOut, status_code=201)
async def create_phone_number(
    body: PhoneNumberCreate,
    ctx: TenantContext = Depends(require_tenant),
    db: AsyncSession = Depends(get_session),
) -> PhoneNumberOut:
    agent = await repo.get_agent(db, ctx.tenant_id, body.agent_id)
    if agent is None:
        raise HTTPException(status_code=422, detail="agent not found")
    pn = PhoneNumber(tenant_id=ctx.tenant_id, e164=body.e164, agent_id=body.agent_id)
    db.add(pn)
    try:
        await db.flush()
    except IntegrityError:
        raise HTTPException(status_code=409, detail="number already registered")
    return PhoneNumberOut.model_validate(pn, from_attributes=True)


@router.get("", response_model=list[PhoneNumberOut])
async def list_phone_numbers(
    ctx: TenantContext = Depends(require_tenant),
    db: AsyncSession = Depends(get_session),
) -> list[PhoneNumberOut]:
    rows = (
        await db.execute(select(PhoneNumber).where(PhoneNumber.tenant_id == ctx.tenant_id))
    ).scalars()
    return [PhoneNumberOut.model_validate(r, from_attributes=True) for r in rows]


@router.delete("/{phone_number_id}", status_code=204)
async def delete_phone_number(
    phone_number_id: uuid.UUID,
    ctx: TenantContext = Depends(require_tenant),
    db: AsyncSession = Depends(get_session),
) -> None:
    pn = (
        await db.execute(
            select(PhoneNumber).where(
                PhoneNumber.id == phone_number_id, PhoneNumber.tenant_id == ctx.tenant_id
            )
        )
    ).scalar_one_or_none()
    if pn is None:
        raise HTTPException(status_code=404, detail="phone number not found")
    await db.delete(pn)
    await db.flush()
