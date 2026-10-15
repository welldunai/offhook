"""Per-tenant API rate limiting — Postgres fixed-window counter (no Redis).

One row per (tenant, minute). Each request does an atomic upsert-increment and
reads back the new count; over the tenant's ``rate_limit_per_min`` it's a 429.
Fixed-window is simple and cheap; bursts at window edges are acceptable for an
API guard. Old windows are pruned opportunistically by the worker (see
``prune_old_windows``).
"""

from __future__ import annotations

import uuid

from sqlalchemy import delete, func, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import RateLimitCounter


async def hit(db: AsyncSession, tenant_id: uuid.UUID, limit: int) -> tuple[bool, int]:
    """Increment this minute's counter. Returns (allowed, new_count)."""
    window = func.date_trunc("minute", func.now())
    stmt = (
        insert(RateLimitCounter)
        .values(tenant_id=tenant_id, window_start=window, count=1)
        .on_conflict_do_update(
            index_elements=[RateLimitCounter.tenant_id, RateLimitCounter.window_start],
            set_={"count": RateLimitCounter.count + 1},
        )
        .returning(RateLimitCounter.count)
    )
    count = (await db.execute(stmt)).scalar_one()
    return count <= limit, count


async def prune_old_windows(db: AsyncSession) -> int:
    """Delete counter rows older than a few minutes. Returns rows removed."""
    cutoff = func.now() - text("interval '5 minutes'")
    res = await db.execute(delete(RateLimitCounter).where(RateLimitCounter.window_start < cutoff))
    return res.rowcount or 0
