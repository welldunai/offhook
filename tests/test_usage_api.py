"""GET /v1/usage: default window, the `from`/`to` range, and the response shape."""
from datetime import datetime, timedelta, timezone

import pytest

from app.db.models import UsageRecord

NOW = datetime.now(timezone.utc)
OLD = NOW - timedelta(days=90)


@pytest.fixture
async def usage(session, tenant):
    session.add_all([
        UsageRecord(tenant_id=tenant.id, kind="call", seconds=30, created_at=NOW),
        UsageRecord(tenant_id=tenant.id, kind="call", seconds=50, created_at=OLD),
    ])
    await session.commit()
    return tenant


async def test_defaults_to_current_month(client, usage):
    r = await client.get("/v1/usage")
    assert r.status_code == 200
    assert r.json()["total_seconds"] == 30 and r.json()["call_count"] == 1


async def test_from_param_sets_range_start(client, usage):
    since = (OLD - timedelta(days=1)).isoformat()
    r = await client.get("/v1/usage", params={"from": since})
    assert r.status_code == 200
    body = r.json()
    assert body["total_seconds"] == 80 and body["call_count"] == 2
    assert "from" in body and "from_" not in body


async def test_to_param_sets_range_end(client, usage):
    r = await client.get("/v1/usage", params={"from": (OLD - timedelta(days=1)).isoformat(),
                                              "to": (OLD + timedelta(days=1)).isoformat()})
    assert r.status_code == 200 and r.json()["total_seconds"] == 50
