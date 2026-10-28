"""How many calls this process is running right now.

Every kind of call counts: phone calls (``app.runner``), dashboard test calls and
demo calls (``app.browser.call``). On Cloudflare the container asks this before
going to sleep, so it never stops in the middle of a conversation.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager

_active = 0


def active_calls() -> int:
    """Return the number of calls running in this process."""
    return _active


@contextmanager
def call_running() -> Iterator[None]:
    """Count a call as running for the duration of the ``with`` block."""
    global _active
    _active += 1
    try:
        yield
    finally:
        _active -= 1
