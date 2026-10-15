"""Event fan-out — turn a domain event into queued webhook deliveries.

``enqueue_event`` inserts one ``WebhookDelivery`` per enabled endpoint that
subscribes to the event (empty ``events`` = all). The worker delivers them
later with retries, so callers just enqueue and move on. Safe to call inside the
same transaction that changed the call's state.
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import WebhookDelivery, WebhookEndpoint


async def enqueue_event(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    event: str,
    payload: dict[str, Any],
    *,
    call_id: uuid.UUID | None = None,
) -> int:
    endpoints = list(
        (
            await db.execute(
                select(WebhookEndpoint).where(
                    WebhookEndpoint.tenant_id == tenant_id, WebhookEndpoint.enabled.is_(True)
                )
            )
        ).scalars()
    )
    n = 0
    for ep in endpoints:
        if ep.events and event not in ep.events:
            continue
        db.add(
            WebhookDelivery(
                tenant_id=tenant_id, endpoint_id=ep.id, call_id=call_id,
                event=event, payload=payload,
            )
        )
        n += 1
    return n
