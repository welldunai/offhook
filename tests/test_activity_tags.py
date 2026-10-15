"""GET /v1/calls activity feed: filters, tag search, pagination, stats."""
import pytest

from app.db.models import Call


async def _seed(session, tenant_id, rows):
    """rows: list of (direction, status, tags) tuples."""
    for direction, status, tags in rows:
        session.add(Call(
            tenant_id=tenant_id, direction=direction, status=status,
            to_number="+14155550000", call_context_snapshot={}, tags=tags,
        ))
    await session.commit()


@pytest.fixture
async def seeded(session, tenant):
    await _seed(session, tenant.id, [
        ("outbound", "completed", {"region": "North", "motive": "sales"}),
        ("outbound", "failed", {"region": "South", "motive": "sales"}),
        ("inbound", "completed", {"region": "North", "motive": "support"}),
    ])
    return tenant


async def test_lists_all(client, seeded):
    r = await client.get("/v1/calls")
    assert r.status_code == 200 and len(r.json()) == 3
    assert all("tags" in c for c in r.json())


async def test_filter_single_tag(client, seeded):
    r = await client.get("/v1/calls?tag=region:North")
    assert r.status_code == 200
    assert {tuple(sorted(c["tags"].items())) for c in r.json()} == {
        (("motive", "sales"), ("region", "North")),
        (("motive", "support"), ("region", "North")),
    }


async def test_filter_multiple_tags_and(client, seeded):
    r = await client.get("/v1/calls?tag=region:North&tag=motive:sales")
    assert r.status_code == 200 and len(r.json()) == 1
    assert r.json()[0]["tags"] == {"region": "North", "motive": "sales"}


async def test_filter_tag_no_match(client, seeded):
    assert (await client.get("/v1/calls?tag=region:West")).json() == []


async def test_malformed_tag_400(client, seeded):
    r = await client.get("/v1/calls?tag=region")  # missing :value
    assert r.status_code == 400


async def test_tag_value_with_colon(client, session, tenant):
    await _seed(session, tenant.id, [("outbound", "completed", {"slot": "3:00pm"})])
    r = await client.get("/v1/calls?tag=slot:3:00pm")  # only first ':' splits key/value
    assert r.status_code == 200 and len(r.json()) == 1


async def test_filter_status_and_direction(client, seeded):
    assert len((await client.get("/v1/calls?status=failed")).json()) == 1
    assert len((await client.get("/v1/calls?direction=inbound")).json()) == 1


async def test_pagination(client, session, tenant):
    await _seed(session, tenant.id, [("outbound", "completed", {}) for _ in range(5)])
    page1 = await client.get("/v1/calls?limit=2&offset=0")
    page2 = await client.get("/v1/calls?limit=2&offset=2")
    assert len(page1.json()) == 2 and len(page2.json()) == 2
    assert {c["id"] for c in page1.json()}.isdisjoint({c["id"] for c in page2.json()})


async def test_stats(client, seeded):
    r = await client.get("/v1/stats")
    assert r.status_code == 200
    data = r.json()
    assert data["total_calls"] == 3
    assert data["by_status"]["completed"] == 2 and data["by_status"]["failed"] == 1
