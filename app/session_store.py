"""In-memory pending-call session store.

A call is reserved (minting a session_id) before the media transport connects.
The route that places the call stashes the `CallContext` here; the WebSocket /
WebRTC handler pops it when the media stream opens.

Values are either a parsed `CallContext` or a raw dict body (deferred parsing).

Swap to Redis when this needs to survive across replicas.
"""

from __future__ import annotations

import uuid
from typing import Any, Optional, TypeAlias

from app.schemas import CallContext

SessionValue: TypeAlias = CallContext | dict[str, Any]

_sessions: dict[str, SessionValue] = {}


def reserve(value: SessionValue) -> str:
    """Mint a session_id and stash the value. Returns the session_id."""
    sid: str = str(uuid.uuid4())
    _sessions[sid] = value
    return sid


def pop(sid: str) -> Optional[SessionValue]:
    return _sessions.pop(sid, None)


def peek(sid: str) -> Optional[SessionValue]:
    return _sessions.get(sid)


def contains(sid: str) -> bool:
    return sid in _sessions
