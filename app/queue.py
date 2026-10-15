"""A small Postgres-backed work queue (no Redis).

Generic over any model with the queue columns (status/run_after/leased_until/
attempts/max_attempts/last_error) — used for both ``call_jobs`` and
``webhook_deliveries``.

``claim`` is the heart: a single atomic ``UPDATE ... WHERE id = (SELECT ... FOR
UPDATE SKIP LOCKED LIMIT 1)`` so many workers can poll concurrently without
ever handing the same row to two of them. ``complete`` / ``reschedule`` finish a
claimed item; ``reschedule`` applies backoff and gives up after ``max_attempts``.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import TypeVar

from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

T = TypeVar("T")


async def claim(db: AsyncSession, model: type[T], *, lease_seconds: int = 120) -> T | None:
    """Atomically claim one due, unleased item. Returns it (lease held) or None."""
    leased_until = datetime.now(timezone.utc) + timedelta(seconds=lease_seconds)
    due = (
        select(model.id)  # type: ignore[attr-defined]
        .where(
            model.status == "queued",  # type: ignore[attr-defined]
            model.run_after <= func.now(),  # type: ignore[attr-defined]
            or_(model.leased_until.is_(None), model.leased_until < func.now()),  # type: ignore[attr-defined]
        )
        .order_by(model.run_after)  # type: ignore[attr-defined]
        .with_for_update(skip_locked=True)
        .limit(1)
        .scalar_subquery()
    )
    stmt = (
        update(model)
        .where(model.id == due)  # type: ignore[attr-defined]
        .values(
            leased_until=leased_until,
            attempts=model.attempts + 1,  # type: ignore[attr-defined]
            updated_at=func.now(),
        )
        .returning(model)
        .execution_options(synchronize_session=False)
    )
    return (await db.execute(stmt)).scalars().one_or_none()


async def complete(db: AsyncSession, model: type, item_id: uuid.UUID, *, status: str = "done") -> None:
    await db.execute(
        update(model)
        .where(model.id == item_id)
        .values(status=status, leased_until=None, updated_at=func.now())
    )


async def reschedule(
    db: AsyncSession,
    model: type,
    item: object,
    *,
    error: str,
    delay_seconds: float,
    failed_status: str = "failed",
) -> bool:
    """Back off and requeue, or mark terminal if attempts are exhausted.

    Returns True if it will retry, False if it gave up.
    """
    will_retry = item.attempts < item.max_attempts  # type: ignore[attr-defined]
    values = {
        "last_error": error[:2000],
        "leased_until": None,
        "updated_at": func.now(),
    }
    if will_retry:
        values["status"] = "queued"
        values["run_after"] = datetime.now(timezone.utc) + timedelta(seconds=delay_seconds)
    else:
        values["status"] = failed_status
    await db.execute(update(model).where(model.id == item.id).values(**values))  # type: ignore[attr-defined]
    return will_retry
