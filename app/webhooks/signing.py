"""Webhook HMAC signing (Stripe-style).

The signature header is ``t=<unix>,v1=<hex>`` where the signed payload is
``"{t}.{body}"`` HMAC-SHA256'd with the endpoint's secret. Receivers recompute
it and constant-time compare, and should reject stale timestamps to prevent
replay. ``verify_signature`` is provided so receivers (and our tests) can check.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets


def generate_secret() -> str:
    return "whsec_" + secrets.token_urlsafe(32)


def _compute(secret: str, timestamp: int, body: str) -> str:
    msg = f"{timestamp}.{body}".encode()
    return hmac.new(secret.encode(), msg, hashlib.sha256).hexdigest()


def sign_payload(secret: str, body: str, *, timestamp: int) -> str:
    return f"t={timestamp},v1={_compute(secret, timestamp, body)}"


def verify_signature(
    secret: str, body: str, header: str, *, tolerance_seconds: int | None = None, now: int | None = None
) -> bool:
    try:
        parts = dict(p.split("=", 1) for p in header.split(","))
        ts = int(parts["t"])
        sig = parts["v1"]
    except Exception:  # noqa: BLE001
        return False
    if tolerance_seconds is not None and now is not None and abs(now - ts) > tolerance_seconds:
        return False
    return hmac.compare_digest(_compute(secret, ts, body), sig)
