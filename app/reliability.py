"""Reliability primitives: backoff and a small in-process circuit breaker.

``backoff_seconds`` gives exponential backoff with full jitter (so retries from
many workers don't synchronize). ``CircuitBreaker`` stops hammering a provider
that is clearly down: after N consecutive failures it opens for a cooldown,
then allows a single half-open probe before closing again.

Breakers are per (worker) process and keyed by an arbitrary string (e.g.
``"plivo"`` or a webhook host), via ``get_breaker``.
"""

from __future__ import annotations

import random
import time

# Which exceptions/HTTP situations are worth retrying is decided by callers;
# these are pure helpers.


def backoff_seconds(attempt: int, *, base: float = 1.0, cap: float = 300.0) -> float:
    """Full-jitter exponential backoff for the given (1-based) attempt number."""
    raw = min(cap, base * (2 ** max(0, attempt - 1)))
    return random.uniform(0, raw)


class CircuitBreaker:
    """Closed → (failures ≥ threshold) → Open → (after cooldown) → Half-open."""

    def __init__(self, *, fail_threshold: int = 5, reset_timeout: float = 30.0) -> None:
        self._fail_threshold = fail_threshold
        self._reset_timeout = reset_timeout
        self._failures = 0
        self._opened_at: float | None = None
        self._half_open = False

    def allow(self) -> bool:
        if self._opened_at is None:
            return True  # closed
        if time.monotonic() - self._opened_at >= self._reset_timeout:
            self._half_open = True  # allow a single probe
            return True
        return False  # open

    def record_success(self) -> None:
        self._failures = 0
        self._opened_at = None
        self._half_open = False

    def record_failure(self) -> None:
        self._failures += 1
        if self._half_open or self._failures >= self._fail_threshold:
            self._opened_at = time.monotonic()
            self._half_open = False

    @property
    def state(self) -> str:
        if self._opened_at is None:
            return "closed"
        return "half_open" if self._half_open else "open"


_breakers: dict[str, CircuitBreaker] = {}


def get_breaker(key: str, **kwargs) -> CircuitBreaker:
    if key not in _breakers:
        _breakers[key] = CircuitBreaker(**kwargs)
    return _breakers[key]


class CircuitOpenError(RuntimeError):
    """Raised when a call is short-circuited by an open breaker."""
