"""Repository layer: tenant scoping and call counters."""
import uuid

from app.db import repositories as repo
from app.db.models import Call, Tenant
from tests.conftest import make_connection


async def test_get_connection_is_tenant_scoped(session, tenant):
    other = Tenant(name="Other", slug=f"o-{uuid.uuid4().hex[:8]}")
    session.add(other)
    await session.commit()
    conn = await make_connection(session, other.id, kind="llm", provider="groq", secrets={"api_key": "x"})

    # asking as the wrong tenant returns nothing
    assert await repo.get_connection(session, tenant.id, conn.id) is None
    assert await repo.get_connection(session, other.id, conn.id) is not None


async def test_count_active_calls(session, tenant):
    for status in ("queued", "dialing", "in_progress", "completed", "failed"):
        session.add(Call(tenant_id=tenant.id, direction="outbound", status=status, call_context_snapshot={}))
    await session.commit()
    # only queued/dialing/in_progress occupy a slot
    assert await repo.count_active_calls(session, tenant.id) == 3


async def test_count_calls_this_month(session, tenant):
    for _ in range(4):
        session.add(Call(tenant_id=tenant.id, direction="outbound", status="completed", call_context_snapshot={}))
    await session.commit()
    assert await repo.count_calls_this_month(session, tenant.id) == 4


async def test_get_call_by_session_token(session, tenant):
    call = Call(tenant_id=tenant.id, direction="outbound", status="queued",
                call_context_snapshot={}, session_token="tok-abc")
    session.add(call)
    await session.commit()
    found = await repo.get_call_by_session_token(session, "tok-abc")
    assert found is not None and found.id == call.id
    assert await repo.get_call_by_session_token(session, "nope") is None


async def test_get_call_scoped(session, tenant):
    other = Tenant(name="Other", slug=f"o-{uuid.uuid4().hex[:8]}")
    session.add(other)
    await session.commit()
    call = Call(tenant_id=other.id, direction="outbound", status="queued", call_context_snapshot={})
    session.add(call)
    await session.commit()
    assert await repo.get_call(session, tenant.id, call.id) is None
