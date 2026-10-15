"""Activity, content, and stats — the SendGrid-style observability surface.

  GET /v1/calls                      activity feed (filter + paginate)
  GET /v1/calls/{id}/events          the raw, ordered call log (timeline)
  GET /v1/calls/{id}/transcript      the conversation content
  GET /v1/stats                      aggregates: counts by status, failure rate, durations
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import TenantContext, require_tenant
from app.db import repositories as repo
from app.db.engine import get_session
from app.db.models import Call, CallEvent

router = APIRouter(tags=["activity"])


class CallSummary(BaseModel):
    id: uuid.UUID
    status: str
    direction: str
    to_number: str | None
    from_number: str | None
    provider_call_id: str | None
    error_code: str | None
    duration_seconds: int | None
    tags: dict[str, str]
    created_at: datetime
    started_at: datetime | None
    ended_at: datetime | None


class EventOut(BaseModel):
    type: str
    data: dict[str, Any]
    error_code: str | None
    ts: datetime


def _duration(c: Call) -> int | None:
    if c.started_at and c.ended_at:
        return max(0, int((c.ended_at - c.started_at).total_seconds()))
    return None


@router.get("/calls", response_model=list[CallSummary])
async def list_calls(
    status: str | None = None,
    direction: str | None = None,
    to_number: str | None = None,
    from_number: str | None = None,
    error_code: str | None = None,
    tag: list[str] | None = Query(
        default=None,
        description='Filter by tag, formatted "key:value" (e.g. region:North). '
        "Repeat the param to require multiple tags (AND).",
    ),
    since: datetime | None = None,
    until: datetime | None = None,
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    ctx: TenantContext = Depends(require_tenant),
    db: AsyncSession = Depends(get_session),
) -> list[CallSummary]:
    conds = [Call.tenant_id == ctx.tenant_id]
    if status:
        conds.append(Call.status == status)
    if direction:
        conds.append(Call.direction == direction)
    if to_number:
        conds.append(Call.to_number == to_number)
    if from_number:
        conds.append(Call.from_number == from_number)
    if error_code:
        conds.append(Call.error_code == error_code)
    if tag:
        # Match calls whose tags contain every requested key/value pair:
        # tags @> '{"region":"North","motive":"sales"}'  (uses the GIN index).
        wanted: dict[str, str] = {}
        for item in tag:
            key, sep, value = item.partition(":")
            if not sep or not key:
                raise HTTPException(
                    status_code=400,
                    detail=f"invalid tag filter {item!r}; expected 'key:value'",
                )
            wanted[key] = value
        conds.append(Call.tags.contains(wanted))
    if since:
        conds.append(Call.created_at >= since)
    if until:
        conds.append(Call.created_at < until)

    rows = (
        await db.execute(
            select(Call).where(*conds).order_by(Call.created_at.desc()).limit(limit).offset(offset)
        )
    ).scalars()
    return [
        CallSummary(
            id=c.id, status=c.status, direction=c.direction, to_number=c.to_number,
            from_number=c.from_number, provider_call_id=c.provider_call_id,
            error_code=c.error_code, duration_seconds=_duration(c), tags=c.tags,
            created_at=c.created_at, started_at=c.started_at, ended_at=c.ended_at,
        )
        for c in rows
    ]


@router.get("/calls/{call_id}/events", response_model=list[EventOut])
async def call_events(
    call_id: uuid.UUID,
    ctx: TenantContext = Depends(require_tenant),
    db: AsyncSession = Depends(get_session),
) -> list[EventOut]:
    if await repo.get_call(db, ctx.tenant_id, call_id) is None:
        raise HTTPException(status_code=404, detail="call not found")
    rows = (
        await db.execute(
            select(CallEvent)
            .where(CallEvent.call_id == call_id, CallEvent.tenant_id == ctx.tenant_id)
            .order_by(CallEvent.ts)
        )
    ).scalars()
    return [EventOut(type=e.type, data=e.data, error_code=e.error_code, ts=e.ts) for e in rows]


@router.get("/calls/{call_id}/transcript")
async def call_transcript(
    call_id: uuid.UUID,
    ctx: TenantContext = Depends(require_tenant),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    call = await repo.get_call(db, ctx.tenant_id, call_id)
    if call is None:
        raise HTTPException(status_code=404, detail="call not found")
    return {
        "call_id": str(call_id),
        "status": call.status,
        "summary": (call.outcome or {}).get("summary"),
        "transcript": call.transcript or [],
    }


@router.get("/stats")
async def stats(
    since: datetime | None = None,
    until: datetime | None = None,
    ctx: TenantContext = Depends(require_tenant),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    conds = [Call.tenant_id == ctx.tenant_id]
    if since is None and until is None:
        conds.append(Call.created_at >= func.date_trunc("month", func.now()))
    if since:
        conds.append(Call.created_at >= since)
    if until:
        conds.append(Call.created_at < until)

    by_status = dict(
        (
            await db.execute(
                select(Call.status, func.count()).where(*conds).group_by(Call.status)
            )
        ).all()
    )
    by_error = dict(
        (
            await db.execute(
                select(Call.error_code, func.count())
                .where(*conds, Call.error_code.is_not(None))
                .group_by(Call.error_code)
            )
        ).all()
    )
    dur = (
        await db.execute(
            select(
                func.coalesce(func.sum(func.extract("epoch", Call.ended_at - Call.started_at)), 0),
                func.count().filter(Call.ended_at.is_not(None)),
            ).where(*conds, Call.started_at.is_not(None), Call.ended_at.is_not(None))
        )
    ).one()

    total = sum(by_status.values())
    failed = by_status.get("failed", 0)
    completed_with_dur = int(dur[1]) or 0
    total_seconds = int(dur[0])
    return {
        "total_calls": total,
        "by_status": by_status,
        "by_error_code": by_error,
        "failure_rate": round(failed / total, 4) if total else 0.0,
        "total_seconds": total_seconds,
        "avg_seconds": round(total_seconds / completed_with_dur, 1) if completed_with_dur else 0.0,
    }
