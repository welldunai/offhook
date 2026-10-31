"""GET /v1/admin/stats: how Offhook is being used, per UTC day, for its operators.

Combines the hosted product (Neon: sign-ups, agents, test calls, phone calls)
with the website demo (the demo Worker's counts). Only dashboard users listed in
``ADMIN_USER_IDS`` may see it; everyone else gets 403 with their own user ID, so
an operator can find theirs. Counts only: no transcripts, plans or emails.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import Date, cast, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import TenantContext, require_tenant
from app.db.engine import get_session
from app.db.models import Agent, Call, Connection, Tenant, UsageRecord, User
from app.demo.config import DemoSettings
from app.demo.worker import WorkerClient
from app.logger import logger
from app.settings import settings

router = APIRouter(prefix="/admin", tags=["admin"])


def admin_ids() -> set[str]:
    """The user IDs allowed to see stats, from ``ADMIN_USER_IDS``."""
    return {s.strip() for s in settings.admin_user_ids.split(",") if s.strip()}


def require_admin(ctx: TenantContext = Depends(require_tenant)) -> TenantContext:
    """Let through only dashboard users listed in ``ADMIN_USER_IDS``.

    Args:
        ctx: The signed-in caller.

    Returns:
        The caller's context.

    Raises:
        HTTPException: 403 for API keys and other users; the detail carries the
            caller's own user ID, so an operator can add theirs.
    """
    if ctx.user_id is None or str(ctx.user_id) not in admin_ids():
        raise HTTPException(
            status_code=403,
            detail={"error": "not_admin", "message": "Stats are for Offhook's operators.",
                    "user_id": str(ctx.user_id) if ctx.user_id else None},
        )
    return ctx


async def _per_day(db: AsyncSession, created: Any, since: datetime, *where: Any, value: Any = None) -> dict[str, int]:
    """Count rows (or sum ``value``) per UTC day since ``since``.

    Args:
        db: The session.
        created: The timestamp column to bucket by.
        since: The first instant to include.
        where: Extra conditions.
        value: A column to sum instead of counting rows.

    Returns:
        ``{"YYYY-MM-DD": n}`` for days with any rows.
    """
    day = cast(func.timezone("UTC", created), Date)
    agg = func.coalesce(func.sum(value), 0) if value is not None else func.count()
    rows = await db.execute(select(day, agg).where(created >= since, *where).group_by(day))
    return {d.isoformat(): int(n) for d, n in rows.all()}


async def _demo(days: int) -> dict[str, Any] | None:
    """The demo Worker's daily counts, or None if it isn't configured or reachable."""
    demo = DemoSettings()
    if not demo.hmac_secret:
        return None
    try:
        return await WorkerClient(demo.worker_url, demo.hmac_secret).stats(days)
    except httpx.HTTPError as e:
        logger.warning(f"[stats] demo stats unavailable: {e!r}")
        return None


@router.get("/stats")
async def get_stats(
    days: int = Query(default=30, ge=1, le=365),
    _admin: TenantContext = Depends(require_admin),
    db: AsyncSession = Depends(get_session),
) -> dict[str, Any]:
    """Usage per UTC day for the last ``days`` days, oldest first, plus all-time totals.

    Args:
        days: How many days back, including today.

    Returns:
        ``{"days": [...], "totals": {...}, "demo_use_cases": {...} | None, "demo_available": bool}``.
        Each day has signups, agents, connections, test_calls, test_call_seconds,
        calls, calls_completed, calls_failed and call_seconds, plus demo_* counts
        from the website demo (zero when it's unavailable).
    """
    today = datetime.now(timezone.utc).date()
    first = today - timedelta(days=days - 1)
    since = datetime.combine(first, datetime.min.time(), tzinfo=timezone.utc)

    series = {
        "signups": await _per_day(db, User.created_at, since),
        "agents": await _per_day(db, Agent.created_at, since),
        "connections": await _per_day(db, Connection.created_at, since),
        "test_calls": await _per_day(db, UsageRecord.created_at, since, UsageRecord.kind == "test_call"),
        "test_call_seconds": await _per_day(db, UsageRecord.created_at, since, UsageRecord.kind == "test_call", value=UsageRecord.seconds),
        "calls": await _per_day(db, Call.created_at, since),
        "calls_completed": await _per_day(db, Call.created_at, since, Call.status == "completed"),
        "calls_failed": await _per_day(db, Call.created_at, since, Call.status == "failed"),
        "call_seconds": await _per_day(db, UsageRecord.created_at, since, UsageRecord.kind == "call", value=UsageRecord.seconds),
    }
    demo = await _demo(days)
    demo_days = {d["day"]: d for d in (demo or {}).get("days", [])}

    out_days = []
    for i in range(days):
        d = (first + timedelta(days=i)).isoformat()
        row: dict[str, Any] = {"day": d, **{k: v.get(d, 0) for k, v in series.items()}}
        for k, v in demo_days.get(d, {}).items():
            if k != "day":
                row[f"demo_{k}"] = v
        out_days.append(row)

    async def count(model: Any, *where: Any) -> int:
        return int((await db.execute(select(func.count()).select_from(model).where(*where))).scalar_one())

    totals = {
        "workspaces": await count(Tenant),
        "users": await count(User),
        "agents": await count(Agent),
        "connections": await count(Connection),
        "test_calls": await count(UsageRecord, UsageRecord.kind == "test_call"),
        "calls": await count(Call),
    }
    return {
        "days": out_days,
        "totals": totals,
        "demo_use_cases": (demo or {}).get("use_cases"),
        "demo_available": demo is not None,
    }
