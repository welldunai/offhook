"""Test calls: talk to one of your agents from the dashboard, in the browser.

Not a phone call: the browser streams microphone audio over a WebSocket and the
agent answers with the workspace's own providers (its STT, LLM and TTS
connections and its tools), exactly as on a real call.

  1. ``POST /v1/agents/{agent_id}/test-call`` (authenticated like any /v1 route)
     checks the agent and its connections, and returns a single-use ticket.
  2. The browser opens ``/v1/test-calls/ws?ticket=…`` (a WebSocket can't carry
     the Authorization header, hence the ticket) and the call runs.

Tickets live in this process's memory, which is fine for the single API process
hosted Offhook runs; several API processes would need a shared store.
"""

from __future__ import annotations

import json
import secrets
import time
import uuid
from dataclasses import dataclass, field

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import TenantContext, require_tenant
from app.browser.call import BrowserCall, Limits
from app.browser.socket import run_guarded
from app.db import repositories as repo
from app.db.engine import get_session, session_scope
from app.logger import logger
from app.settings import settings
from app.tenancy.resolve import prepare_call, resolve_custom_tools

#: How long a test call may run, and its wrap-up and silence timings.
LIMITS = Limits(max_seconds=300, wrap_up_seconds=20, silence_seconds=30)
#: Seconds a ticket stays valid.
TICKET_TTL = 60
#: Test calls one workspace may have running at once.
MAX_PER_TENANT = 2

router = APIRouter(tags=["test calls"])
socket_router = APIRouter()


@dataclass
class _Ticket:
    tenant_id: uuid.UUID
    agent_id: uuid.UUID
    context: dict
    expires_at: float


@dataclass
class _State:
    tickets: dict[str, _Ticket] = field(default_factory=dict)
    active: dict[uuid.UUID, int] = field(default_factory=dict)

    def issue(self, ticket: _Ticket) -> str:
        """Store a ticket and return its token. Expired tickets are dropped first."""
        now = time.monotonic()
        self.tickets = {k: v for k, v in self.tickets.items() if v.expires_at > now}
        token = secrets.token_urlsafe(32)
        self.tickets[token] = ticket
        return token

    def redeem(self, token: str | None) -> _Ticket | None:
        """Return and forget the ticket for ``token``, once, if it hasn't expired."""
        ticket = self.tickets.pop(token or "", None)
        if ticket is None or ticket.expires_at <= time.monotonic():
            return None
        return ticket


_state = _State()


class TestCallStart(BaseModel):
    """Optional call context for the test, the same as a real call's ``context``."""

    context: dict = Field(default_factory=dict)


class TestCallTicket(BaseModel):
    ticket: str
    ws_url: str
    max_seconds: int


@router.post("/agents/{agent_id}/test-call", response_model=TestCallTicket)
async def start_test_call(
    agent_id: uuid.UUID,
    request: Request,
    body: TestCallStart | None = None,
    ctx: TenantContext = Depends(require_tenant),
    db: AsyncSession = Depends(get_session),
) -> TestCallTicket:
    """Check the agent can run and hand out a ticket for its test call.

    Args:
        agent_id: One of the workspace's agents.
        request: Used to build the WebSocket address when PUBLIC_BASE_URL is unset (dev).
        body: Optional call context.
        ctx: The signed-in workspace.
        db: Database session.

    Returns:
        The ticket, the WebSocket address and the call's time limit.

    Raises:
        HTTPException: 404 for an unknown agent; 409 if a connection is missing or
            the workspace already has the maximum test calls running.
    """
    agent = await repo.get_agent(db, ctx.tenant_id, agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail="agent not found")
    # Fail now, with a clear reason, rather than after the microphone is on.
    await prepare_call(db, ctx.tenant_id, agent, context={}, metadata={}, need_telephony=False)
    if _state.active.get(ctx.tenant_id, 0) >= MAX_PER_TENANT:
        raise HTTPException(status_code=409, detail=f"you already have {MAX_PER_TENANT} test calls running")

    token = _state.issue(
        _Ticket(ctx.tenant_id, agent.id, (body.context if body else {}) or {}, time.monotonic() + TICKET_TTL)
    )
    return TestCallTicket(ticket=token, ws_url=_ws_url(request), max_seconds=LIMITS.max_seconds)


@socket_router.websocket("/v1/test-calls/ws")
async def test_call_socket(websocket: WebSocket) -> None:
    """One test call. Origin must be the dashboard; the ticket must be fresh and unused.

    Args:
        websocket: The browser's socket, with ``?ticket=``.
    """
    if websocket.headers.get("origin") not in settings.cors_origin_list:
        await websocket.close(code=1008)
        return
    await websocket.accept()
    ticket = _state.redeem(websocket.query_params.get("ticket"))
    if ticket is None:
        return await _refuse(websocket, "bad_ticket", "This test call expired. Start it again.")
    if _state.active.get(ticket.tenant_id, 0) >= MAX_PER_TENANT:
        return await _refuse(websocket, "busy", f"You already have {MAX_PER_TENANT} test calls running.")

    # Load everything up front so the database session isn't held through the call.
    async with session_scope() as db:
        agent = await repo.get_agent(db, ticket.tenant_id, ticket.agent_id)
        if agent is None:
            return await _refuse(websocket, "not_found", "That agent no longer exists.")
        try:
            prepared = await prepare_call(
                db, ticket.tenant_id, agent, context=ticket.context, metadata={"test_call": True}, need_telephony=False
            )
        except HTTPException as e:
            return await _refuse(websocket, "not_ready", str(e.detail))
        tools = await resolve_custom_tools(db, ticket.tenant_id, prepared.tool_ids)

    call = BrowserCall(str(uuid.uuid4()), prepared.call_context, LIMITS, prepared.voice_config, custom_tools=tools)
    _state.active[ticket.tenant_id] = _state.active.get(ticket.tenant_id, 0) + 1
    logger.info(f"[test-call] {call.session_id} starting for agent {agent.id}")
    try:
        await run_guarded(call, websocket)
    finally:
        _state.active[ticket.tenant_id] -= 1
        logger.info(f"[test-call] {call.session_id} ended: {call.end_reason}")


def _ws_url(request: Request) -> str:
    """The test-call WebSocket address, from PUBLIC_BASE_URL (or the request, in dev)."""
    base = (settings.public_base_url or str(request.base_url)).rstrip("/")
    scheme, rest = base.split("://", 1)
    return f"{'wss' if scheme == 'https' else 'ws'}://{rest}/v1/test-calls/ws"


async def _refuse(websocket: WebSocket, error: str, message: str) -> None:
    """Tell the browser why, then close."""
    await websocket.send_text(json.dumps({"type": "error", "error": error, "message": message}))
    await websocket.close(code=1008)
