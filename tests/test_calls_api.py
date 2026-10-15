"""POST /v1/calls — creation, tags, idempotency, and quotas."""
import uuid

from sqlalchemy import update

from app.db.models import Tenant
from tests.conftest import make_full_agent


async def _agent(session, tenant):
    return await make_full_agent(session, tenant.id)


async def test_create_call_queues_with_tags(client, session, tenant):
    agent = await _agent(session, tenant)
    r = await client.post("/v1/calls", json={
        "agent_id": str(agent.id), "to_number": "+14155550123",
        "tags": {"region": "North", "motive": "sales"},
    })
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["status"] == "queued" and body["direction"] == "outbound"

    detail = await client.get(f"/v1/calls/{body['id']}")
    assert detail.status_code == 200
    assert detail.json()["tags"] == {"region": "North", "motive": "sales"}


async def test_unknown_agent_404(client):
    r = await client.post("/v1/calls", json={"agent_id": str(uuid.uuid4()), "to_number": "+14155550123"})
    assert r.status_code == 404


async def test_idempotency_returns_same_call(client, session, tenant):
    agent = await _agent(session, tenant)
    body = {"agent_id": str(agent.id), "to_number": "+14155550123"}
    h = {"Idempotency-Key": "order-1"}
    r1 = await client.post("/v1/calls", json=body, headers=h)
    r2 = await client.post("/v1/calls", json=body, headers=h)
    assert r1.status_code == 201 and r2.status_code in (200, 201)
    assert r1.json()["id"] == r2.json()["id"]
    # exactly one call exists
    assert len((await client.get("/v1/calls")).json()) == 1


async def test_idempotency_conflict_on_different_body(client, session, tenant):
    agent = await _agent(session, tenant)
    h = {"Idempotency-Key": "order-2"}
    await client.post("/v1/calls", json={"agent_id": str(agent.id), "to_number": "+14155550111"}, headers=h)
    r = await client.post("/v1/calls", json={"agent_id": str(agent.id), "to_number": "+14155550999"}, headers=h)
    assert r.status_code == 409


async def test_concurrent_quota_429(client, session, tenant):
    agent = await _agent(session, tenant)
    await session.execute(update(Tenant).where(Tenant.id == tenant.id).values(max_concurrent_calls=0))
    await session.commit()
    r = await client.post("/v1/calls", json={"agent_id": str(agent.id), "to_number": "+14155550123"})
    assert r.status_code == 429


async def test_monthly_cap_429(client, session, tenant):
    agent = await _agent(session, tenant)
    await session.execute(
        update(Tenant).where(Tenant.id == tenant.id).values(max_concurrent_calls=10, monthly_call_cap=0)
    )
    await session.commit()
    r = await client.post("/v1/calls", json={"agent_id": str(agent.id), "to_number": "+14155550123"})
    assert r.status_code == 429
