"""Usage API — aggregate metered usage for the tenant.

Defaults to the current calendar month. Returns total billable seconds and the
number of metered calls; extend with cost once pricing lands.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import TenantContext, require_tenant
from app.db.engine import get_session
from app.db.models import UsageRecord

router = APIRouter(prefix="/usage", tags=["usage"])


class UsageOut(BaseModel):
    from_: datetime | None = None
    to: datetime | None = None
    total_seconds: int
    call_count: int


@router.get("", response_model=UsageOut)
async def get_usage(
    from_: datetime | None = None,
    to: datetime | None = None,
    ctx: TenantContext = Depends(require_tenant),
    db: AsyncSession = Depends(get_session),
) -> UsageOut:
    conds = [UsageRecord.tenant_id == ctx.tenant_id]
    if from_ is None and to is None:
        conds.append(UsageRecord.created_at >= func.date_trunc("month", func.now()))
    if from_ is not None:
        conds.append(UsageRecord.created_at >= from_)
    if to is not None:
        conds.append(UsageRecord.created_at < to)

    row = (
        await db.execute(
            select(
                func.coalesce(func.sum(UsageRecord.seconds), 0),
                func.count(),
            ).where(*conds)
        )
    ).one()
    return UsageOut(from_=from_, to=to, total_seconds=int(row[0]), call_count=int(row[1]))
