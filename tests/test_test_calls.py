"""Dashboard test calls: ticket issue and redemption, origin checks, limits."""

import json
import uuid

import pytest

import app.api.test_calls as tc
from tests.conftest import make_full_agent

SITE = "http://localhost:5173"  # in the default CORS origins


class FakeSocket:
    """Enough of a Starlette WebSocket for the handler."""

    def __init__(self, ticket: str | None, origin: str = SITE) -> None:
        self.headers = {"origin": origin}
        self.query_params = {"ticket": ticket} if ticket else {}
        self.accepted = False
        self.sent: list[dict] = []
        self.closed: int | None = None

    async def accept(self) -> None:
        self.accepted = True

    async def send_text(self, text: str) -> None:
        self.sent.append(json.loads(text))

    async def close(self, code: int = 1000) -> None:
        self.closed = code


@pytest.fixture(autouse=True)
def fresh_state(monkeypatch):
    monkeypatch.setattr(tc, "_state", tc._State())
    runs: list = []

    async def fake_run(call, websocket):
        runs.append(call)
        call.end_reason = "hung_up"

    monkeypatch.setattr(tc, "run_guarded", fake_run)
    return runs


async def ticket_for(client, agent_id, context=None):
    r = await client.post(f"/v1/agents/{agent_id}/test-call", json={"context": context or {}})
    assert r.status_code == 200, r.text
    return r.json()


async def test_issues_a_ticket_for_your_agent(client, session, tenant):
    agent = await make_full_agent(session, tenant.id)
    body = await ticket_for(client, agent.id)
    assert body["max_seconds"] == tc.LIMITS.max_seconds
    assert body["ws_url"].endswith("/v1/test-calls/ws")
    assert body["ws_url"].startswith(("ws://", "wss://"))
    assert len(body["ticket"]) > 30


async def test_unknown_or_other_workspaces_agent_is_404(client, session, tenant):
    from app.db.models import Tenant

    other = Tenant(name="Other", slug=f"other-{uuid.uuid4().hex[:6]}")
    session.add(other)
    await session.commit()
    theirs = await make_full_agent(session, other.id)
    assert (await client.post(f"/v1/agents/{uuid.uuid4()}/test-call", json={})).status_code == 404
    assert (await client.post(f"/v1/agents/{theirs.id}/test-call", json={})).status_code == 404


async def test_a_ticket_runs_the_agent_once(client, session, tenant, fresh_state):
    agent = await make_full_agent(session, tenant.id)
    ticket = (await ticket_for(client, agent.id, {"customer_name": "Priya"}))["ticket"]
    ws = FakeSocket(ticket)
    await tc.test_call_socket(ws)
    (call,) = fresh_state
    assert call.ctx.agent.name == "Alex"
    assert call.ctx.context == {"customer_name": "Priya"}
    assert call.cfg.stt.provider_name == "deepgram" and call.cfg.llm.provider_name == "groq"
    assert tc._state.active[tenant.id] == 0  # the slot is given back

    again = FakeSocket(ticket)
    await tc.test_call_socket(again)
    assert again.sent[0]["error"] == "bad_ticket" and again.closed == 1008
    assert len(fresh_state) == 1


async def test_other_origins_are_refused_before_accepting(client, session, tenant, fresh_state):
    agent = await make_full_agent(session, tenant.id)
    ticket = (await ticket_for(client, agent.id))["ticket"]
    ws = FakeSocket(ticket, origin="https://evil.example")
    await tc.test_call_socket(ws)
    assert not ws.accepted and ws.closed == 1008 and fresh_state == []


async def test_expired_tickets_are_refused(client, session, tenant, fresh_state, monkeypatch):
    agent = await make_full_agent(session, tenant.id)
    ticket = (await ticket_for(client, agent.id))["ticket"]
    tc._state.tickets[ticket].expires_at = 0
    ws = FakeSocket(ticket)
    await tc.test_call_socket(ws)
    assert ws.sent[0]["error"] == "bad_ticket" and fresh_state == []


async def test_a_workspace_can_run_two_at_once(client, session, tenant):
    agent = await make_full_agent(session, tenant.id)
    tc._state.active[tenant.id] = tc.MAX_PER_TENANT
    r = await client.post(f"/v1/agents/{agent.id}/test-call", json={})
    assert r.status_code == 409 and "test calls running" in r.json()["detail"]


async def test_an_agent_with_an_unusable_connection_is_refused_up_front(client, session, tenant):
    agent = await make_full_agent(session, tenant.id)
    agent.llm_connection_id = agent.stt_connection_id  # an STT connection can't be the LLM
    await session.commit()
    r = await client.post(f"/v1/agents/{agent.id}/test-call", json={})
    assert r.status_code == 409
