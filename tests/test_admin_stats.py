"""GET /v1/admin/stats: operators only, per-day counts, demo numbers merged in."""

import uuid

import pytest

import app.api.stats as stats
from app.auth.dependencies import TenantContext, require_tenant
from app.db.models import UsageRecord, User

ADMIN = uuid.uuid4()


@pytest.fixture
def as_user(tenant, monkeypatch):
    """Sign requests in as a dashboard user; returns a function to pick which."""
    monkeypatch.setattr(stats.settings, "admin_user_ids", f"{ADMIN}, {uuid.uuid4()}")

    def use(user_id):
        from app.main import app  # lazily, like conftest: importing it loads .env

        app.dependency_overrides[require_tenant] = lambda: TenantContext(
            tenant_id=tenant.id, user_id=user_id, principal="user", rate_limit_per_min=10_000
        )

    return use


@pytest.fixture
def demo(monkeypatch):
    """The demo Worker's answer, without calling it."""
    answer = {"days": [], "use_cases": {"lead-qualification": 3}}

    async def fake(days):
        answer["days"] = [{"day": stats.datetime.now(stats.timezone.utc).date().isoformat(), "sessions": 5, "waitlist": 2}]
        return answer

    monkeypatch.setattr(stats, "_demo", fake)
    return answer


async def test_api_keys_and_other_users_are_refused_with_their_own_id(client, as_user):
    r = await client.get("/v1/admin/stats")
    assert r.status_code == 403 and r.json()["detail"]["user_id"] is None
    someone = uuid.uuid4()
    as_user(someone)
    r = await client.get("/v1/admin/stats")
    assert r.status_code == 403 and r.json()["detail"]["user_id"] == str(someone)


async def test_counts_today_and_merges_the_demo(client, session, tenant, as_user, demo):
    as_user(ADMIN)
    before = (await client.get("/v1/admin/stats", params={"days": 7})).json()
    session.add_all([
        User(clerk_user_id=f"user_{uuid.uuid4().hex}", tenant_id=tenant.id),
        UsageRecord(tenant_id=tenant.id, kind="test_call", seconds=40),
        UsageRecord(tenant_id=tenant.id, kind="test_call", seconds=20),
    ])
    await session.commit()

    r = await client.get("/v1/admin/stats", params={"days": 7})
    assert r.status_code == 200
    body = r.json()
    assert len(body["days"]) == 7
    today, was = body["days"][-1], before["days"][-1]
    assert today["signups"] - was["signups"] == 1
    assert today["test_calls"] - was["test_calls"] == 2
    assert today["test_call_seconds"] - was["test_call_seconds"] == 60
    assert today["demo_sessions"] == 5 and today["demo_waitlist"] == 2
    assert body["demo_available"] is True and body["demo_use_cases"] == {"lead-qualification": 3}
    assert body["totals"]["users"] - before["totals"]["users"] == 1


async def test_works_without_the_demo(client, as_user, monkeypatch):
    async def down(days):
        return None

    monkeypatch.setattr(stats, "_demo", down)
    as_user(ADMIN)
    body = (await client.get("/v1/admin/stats", params={"days": 1})).json()
    assert body["demo_available"] is False and "demo_sessions" not in body["days"][0]
