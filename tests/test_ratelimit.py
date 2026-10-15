"""Per-tenant fixed-window rate limiter."""
from app.ratelimit import hit


async def test_allows_under_limit_then_blocks(session, tenant):
    results = [await hit(session, tenant.id, limit=3) for _ in range(5)]
    allowed = [a for a, _ in results]
    counts = [c for _, c in results]
    assert allowed == [True, True, True, False, False]
    assert counts == [1, 2, 3, 4, 5]


async def test_tenants_have_independent_counters(session, tenant):
    import uuid
    from app.db.models import Tenant

    other = Tenant(name="Other", slug=f"o-{uuid.uuid4().hex[:8]}")
    session.add(other)
    await session.commit()

    await hit(session, tenant.id, limit=5)
    await hit(session, tenant.id, limit=5)
    allowed, count = await hit(session, other.id, limit=5)
    assert allowed is True and count == 1  # other tenant unaffected
