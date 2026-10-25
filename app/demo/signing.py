"""HMAC signing shared with the demo Worker (``demo/worker/src/sign.ts``).

Both sides must agree byte for byte; ``tests/demo/test_signing.py`` pins vectors
that the Worker's tests pin too.

  * Tickets: ``<base64url payload>.<hex HMAC-SHA256 of the payload>``, payload
    ``{"sid": ..., "exp": <unix seconds>}``. The Worker issues them; the browser
    hands one to this server when it connects.
  * Requests: this server signs its calls to the Worker's ``/internal/*`` with
    ``x-offhook-timestamp`` (unix seconds) and ``x-offhook-signature`` (hex
    HMAC-SHA256 of ``"<timestamp>.<body>"``).
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import time

#: Seconds a ticket stays valid (matches the Worker).
TICKET_TTL = 60


def _sign(secret: str, message: str) -> str:
    """Return the hex HMAC-SHA256 of ``message`` under ``secret``."""
    return hmac.new(secret.encode(), message.encode(), hashlib.sha256).hexdigest()


def _b64url(data: bytes) -> str:
    """Base64url without padding."""
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def make_ticket(secret: str, session_id: str, now: float | None = None) -> str:
    """Make a ticket the way the Worker does. Used by tests and local tools.

    Args:
        secret: DEMO_HMAC_SECRET.
        session_id: The session the ticket admits.
        now: Unix seconds; defaults to the current time.

    Returns:
        The ticket string.
    """
    exp = int(now if now is not None else time.time()) + TICKET_TTL
    payload = _b64url(json.dumps({"sid": session_id, "exp": exp}, separators=(",", ":")).encode())
    return f"{payload}.{_sign(secret, payload)}"


def read_ticket(secret: str, ticket: object, now: float | None = None) -> str | None:
    """Check a ticket's signature and expiry.

    Args:
        secret: DEMO_HMAC_SECRET.
        ticket: The value the browser sent.
        now: Unix seconds; defaults to the current time.

    Returns:
        The session ID, or None if the ticket is forged, malformed or expired.
    """
    if not isinstance(ticket, str) or len(ticket) > 1024:
        return None
    parts = ticket.split(".")
    if len(parts) != 2:
        return None
    payload, sig = parts
    if not hmac.compare_digest(_sign(secret, payload), sig):
        return None
    try:
        data = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except (ValueError, binascii.Error):
        return None
    sid, exp = data.get("sid") if isinstance(data, dict) else None, data.get("exp") if isinstance(data, dict) else None
    if not isinstance(sid, str) or not isinstance(exp, (int, float)):
        return None
    if exp < (now if now is not None else time.time()):
        return None
    return sid


def sign_request(secret: str, body: str, now: float | None = None) -> dict[str, str]:
    """Sign a request body for the Worker's ``/internal/*`` routes.

    Args:
        secret: DEMO_HMAC_SECRET.
        body: The exact body text that will be sent.
        now: Unix seconds; defaults to the current time.

    Returns:
        The two headers to send with it.
    """
    ts = str(int(now if now is not None else time.time()))
    return {"x-offhook-timestamp": ts, "x-offhook-signature": _sign(secret, f"{ts}.{body}")}
