"""Webhook delivery — sign + POST a single delivery to its endpoint.

Used by the worker. SSRF-validates the URL (with a dev-only private bypass),
signs the body, disables redirects, and reports a retry/terminal outcome.
2xx = delivered; everything else is retryable up to the delivery's max attempts.
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass

import httpx

from app.crypto.envelope import decrypt_secret, get_or_create_tenant_dek
from app.db.models import WebhookDelivery, WebhookEndpoint
from app.security.ssrf import UnsafeURLError, validate_public_url
from app.settings import settings
from app.webhooks.signing import sign_payload


@dataclass
class DeliveryResult:
    ok: bool
    status_code: int | None
    error: str | None


async def _endpoint_secret(db, tenant_id: uuid.UUID, ep: WebhookEndpoint) -> str:
    dek = await get_or_create_tenant_dek(db, tenant_id)
    blob = decrypt_secret(
        dek, ep.secret_ciphertext, ep.secret_nonce,
        tenant_id=tenant_id, connection_id=ep.id, provider_name="webhook",
    )
    return blob["secret"]


async def deliver(db, delivery: WebhookDelivery, endpoint: WebhookEndpoint) -> DeliveryResult:
    try:
        validate_public_url(endpoint.url, allow_private=settings.webhook_allow_private)
    except UnsafeURLError as exc:
        return DeliveryResult(ok=False, status_code=None, error=f"ssrf: {exc}")

    secret = await _endpoint_secret(db, delivery.tenant_id, endpoint)
    envelope = {
        "id": str(delivery.id),
        "event": delivery.event,
        "created": int(time.time()),
        "data": delivery.payload,
    }
    body = json.dumps(envelope, separators=(",", ":"))
    sig = sign_payload(secret, body, timestamp=envelope["created"])

    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=False) as client:
            resp = await client.post(
                endpoint.url,
                content=body,
                headers={
                    "Content-Type": "application/json",
                    "X-Voice-Event": delivery.event,
                    "X-Voice-Signature": sig,
                    "X-Voice-Delivery": str(delivery.id),
                },
            )
    except Exception as exc:  # noqa: BLE001 - network errors are retryable
        return DeliveryResult(ok=False, status_code=None, error=f"{type(exc).__name__}: {exc}")

    ok = 200 <= resp.status_code < 300
    return DeliveryResult(ok=ok, status_code=resp.status_code, error=None if ok else f"HTTP {resp.status_code}")
