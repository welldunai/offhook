"""Call event recording — the audit/observability layer.

``emit_call_event`` does two things in one call, in the caller's transaction:
  1. Appends a row to ``call_events`` — the raw, ordered, queryable call log.
  2. Fans the same event out to the tenant's webhooks (Phase 2 delivery).

Every lifecycle transition (queued/dialing/in_progress/completed/failed),
carrier hangup, and notable error goes through here, so the timeline and the
webhooks never drift. ``classify_error`` maps raw exceptions to stable codes.
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import CallEvent
from app.webhooks.events import enqueue_event


def classify_error(message: str | None) -> str:
    """Map a raw error string to a stable, documented error code."""
    if not message:
        return "unknown_error"
    m = message.lower()
    if "unauthorized" in m or "auth" in m:
        return "carrier_unauthorized"
    if "resolution failed" in m or "connection" in m:
        return "config_error"
    if "timeout" in m or "timed out" in m:
        return "provider_timeout"
    if "plivo api error" in m or "carrier" in m:
        return "carrier_error"
    return "pipeline_error"


async def emit_call_event(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    call_id: uuid.UUID,
    type: str,
    data: dict[str, Any] | None = None,
    *,
    error_code: str | None = None,
) -> None:
    """Record a call event and enqueue matching webhooks (same transaction)."""
    payload = data or {}
    db.add(
        CallEvent(
            tenant_id=tenant_id, call_id=call_id, type=type,
            data=payload, error_code=error_code,
        )
    )
    await enqueue_event(db, tenant_id, type, {**payload, "call_id": str(call_id)}, call_id=call_id)
