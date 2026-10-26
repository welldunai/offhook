"""PATCH /v1/agents/{id}: change what's sent, keep the rest, same checks as create."""

import uuid

import pytest

from app.settings import settings
from tests.conftest import make_connection, make_full_agent


@pytest.fixture
def platform(monkeypatch):
    monkeypatch.setattr(settings, "platform_deepgram_api_key", "dg")
    monkeypatch.setattr(settings, "platform_cartesia_api_key", "ca")
    monkeypatch.setattr(settings, "platform_cartesia_voice_id", "v")
    monkeypatch.setattr(settings, "platform_groq_api_key", "gq")


async def test_attach_a_phone_line_later(client, session, tenant, platform):
    created = (await client.post("/v1/agents", json={"name": "Sam", "instructions": "Screen."})).json()
    assert created["telephony_connection_id"] is None
    line = await make_connection(session, tenant.id, kind="telephony", provider="twilio",
                                 secrets={"account_sid": "AC1", "auth_token": "t", "from_number": "+15550000001"})
    r = await client.patch(f"/v1/agents/{created['id']}", json={"telephony_connection_id": str(line.id)})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["telephony_connection_id"] == str(line.id)
    assert body["name"] == "Sam" and body["instructions"] == "Screen."  # untouched


async def test_switch_a_leg_to_offhooks_and_back(client, session, tenant, platform):
    agent = await make_full_agent(session, tenant.id)
    r = await client.patch(f"/v1/agents/{agent.id}", json={"llm_connection_id": None, "name": "Alex 2"})
    assert r.status_code == 200 and r.json()["llm_connection_id"] is None and r.json()["name"] == "Alex 2"
    assert r.json()["stt_connection_id"] == str(agent.stt_connection_id)


async def test_refuses_bad_changes(client, session, tenant, monkeypatch):
    agent = await make_full_agent(session, tenant.id)
    monkeypatch.setattr(settings, "platform_groq_api_key", None)
    assert (await client.patch(f"/v1/agents/{agent.id}", json={"llm_connection_id": None})).status_code == 422
    assert (await client.patch(f"/v1/agents/{agent.id}", json={"stt_connection_id": str(agent.tts_connection_id)})).status_code == 422
    assert (await client.patch(f"/v1/agents/{agent.id}", json={"name": ""})).status_code == 422
    assert (await client.patch(f"/v1/agents/{uuid.uuid4()}", json={"name": "x"})).status_code == 404


async def test_another_workspaces_agent_is_404(client, session):
    from app.db.models import Tenant

    other = Tenant(name="Other", slug=f"o-{uuid.uuid4().hex[:6]}")
    session.add(other)
    await session.commit()
    theirs = await make_full_agent(session, other.id)
    assert (await client.patch(f"/v1/agents/{theirs.id}", json={"name": "Mine now"})).status_code == 404
