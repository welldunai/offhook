"""Clerk session-JWT verification (dashboard user auth).

The dashboard signs users in with Clerk and sends Clerk's short-lived session
JWT as a bearer token. We verify it against Clerk's JWKS (RS256), checking the
issuer and expiry, and return the claims — ``sub`` is the Clerk user id.

``PyJWKClient`` fetches and caches the JWKS. Configure ``CLERK_ISSUER`` (and
optionally ``CLERK_JWKS_URL``); see ``app/settings.py``.
"""

from __future__ import annotations

from typing import Any

import jwt
from jwt import PyJWKClient

from app.settings import settings


class ClerkError(Exception):
    """Raised when a Clerk JWT can't be verified."""


# Cached JWKS client (lazily created; swappable in tests).
_jwk_client: PyJWKClient | None = None


def _client() -> PyJWKClient:
    global _jwk_client
    if _jwk_client is None:
        if not settings.clerk_jwks:
            raise ClerkError("Clerk is not configured (set CLERK_ISSUER)")
        _jwk_client = PyJWKClient(settings.clerk_jwks)
    return _jwk_client


def verify_clerk_jwt(token: str) -> dict[str, Any]:
    """Verify a Clerk session JWT and return its claims, or raise ClerkError."""
    try:
        signing_key = _client().get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            issuer=settings.clerk_issuer,
            options={
                "verify_aud": False,        # Clerk session tokens have no fixed aud
                "require": ["exp", "iat", "sub"],
                "verify_iss": bool(settings.clerk_issuer),
            },
        )
        return claims
    except ClerkError:
        raise
    except Exception as exc:  # noqa: BLE001 - normalize all jwt errors
        raise ClerkError(str(exc)) from exc


def claims_to_identity(claims: dict[str, Any]) -> tuple[str, str | None]:
    """Extract (clerk_user_id, email) from verified claims."""
    user_id = claims["sub"]
    email = (
        claims.get("email")
        or claims.get("email_address")
        or (claims.get("user", {}) or {}).get("email")
    )
    return user_id, email
