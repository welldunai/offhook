"""API key generation, hashing, and verification.

Key format: ``vk_<env>_<prefix>_<secret>``
  * ``prefix`` — short, random, stored in plaintext + indexed so a key can be
    located with one query (no full-table argon2 scan).
  * ``secret`` — 32 random bytes, base64url. Stored ONLY as an argon2id hash;
    the plaintext is shown to the caller exactly once at creation.

argon2id (not a fast hash) is used because these are bearer secrets: if the DB
leaks, offline brute force should be infeasible.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

from app.settings import settings

_ph = PasswordHasher()

# A fixed hash used to spend ~argon2 time on auth misses, so "unknown prefix"
# and "wrong secret" take similar wall-clock (no timing oracle on existence).
_DUMMY_HASH = _ph.hash("dummy-constant-for-timing")

_PREFIX_BYTES = 6  # ~8 base32-ish chars
_SECRET_BYTES = 32


@dataclass(frozen=True)
class GeneratedKey:
    full_key: str  # returned to the caller once
    prefix: str
    key_hash: str


def generate_key() -> GeneratedKey:
    prefix = secrets.token_hex(_PREFIX_BYTES)  # 12 hex chars
    secret = secrets.token_urlsafe(_SECRET_BYTES)
    full = f"vk_{settings.env}_{prefix}_{secret}"
    return GeneratedKey(full_key=full, prefix=prefix, key_hash=_ph.hash(secret))


def parse_key(full_key: str) -> tuple[str, str] | None:
    """Split a presented key into (prefix, secret). Returns None if malformed."""
    parts = full_key.split("_")
    # vk_<env>_<prefix>_<secret>  -> at least 4 parts; secret may contain '_' ?
    # token_urlsafe uses '-' and '_'... so rejoin the tail as the secret.
    if len(parts) < 4 or parts[0] != "vk":
        return None
    prefix = parts[2]
    secret = "_".join(parts[3:])
    if not prefix or not secret:
        return None
    return prefix, secret


def verify_secret(key_hash: str, secret: str) -> bool:
    try:
        return _ph.verify(key_hash, secret)
    except VerifyMismatchError:
        return False
    except Exception:  # noqa: BLE001 - malformed hash etc.
        return False


def spend_dummy_verify() -> None:
    """Constant-ish work on the auth-miss path to flatten timing."""
    try:
        _ph.verify(_DUMMY_HASH, "definitely-wrong")
    except Exception:  # noqa: BLE001
        pass
