"""Test harness: bind to the voice_test database, build the schema, and expose
fixtures for an authed API client, a DB session, and seeded tenant data.

The DATABASE_URL + master key are set BEFORE any ``app.*`` import so the
settings singleton and the engine bind to the test database, never the dev one.
"""
from __future__ import annotations

import base64
import os

# --- bind test environment before importing the app -------------------------
os.environ["DATABASE_URL"] = "postgresql+asyncpg://voice:voice@localhost:5432/voice_test"
os.environ["ENV"] = "dev"
os.environ["MASTER_ENCRYPTION_KEY"] = base64.b64encode(b"test-master-key-0123456789abcdef").decode()
os.environ["MASTER_KEY_ID"] = "v1"
os.environ["KEY_PROVIDER"] = "env"
os.environ["ENABLE_PREBUILT_UI"] = "0"
os.environ["ENABLE_RLS"] = "0"
os.environ["WEBHOOK_ALLOW_PRIVATE"] = "0"  # SSRF guard active; tests use public IP literals

import uuid  # noqa: E402

import pytest  # noqa: E402

import pytest_asyncio  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.crypto.envelope import encrypt_secret, get_or_create_tenant_dek  # noqa: E402
from app.db.engine import _sessionmaker, get_engine  # noqa: E402
from app.db.models import Agent, ApiKey, Base, Connection, Tenant  # noqa: E402

# Tables truncated between tests (children first isn't needed — CASCADE).
_TABLES = [t.name for t in reversed(Base.metadata.sorted_tables)]


@pytest_asyncio.fixture
async def _db():
    """Ensure schema exists, give each test an empty database, dispose the
    engine afterwards so connections never leak across event loops. Pulled in
    by every DB fixture; pure-unit tests don't touch the database at all."""
    engine = get_engine()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.execute(text(f"TRUNCATE {', '.join(_TABLES)} RESTART IDENTITY CASCADE"))
    yield
    await engine.dispose()


@pytest_asyncio.fixture
async def session(_db):
    """A committed AsyncSession for arranging test data."""
    async with _sessionmaker() as s:
        yield s


@pytest_asyncio.fixture
async def tenant(session) -> Tenant:
    t = Tenant(name="Acme", slug=f"acme-{uuid.uuid4().hex[:8]}")
    session.add(t)
    await session.commit()
    await session.refresh(t)
    return t


@pytest_asyncio.fixture
async def api_key(session, tenant) -> str:
    """Create a real API key for ``tenant`` and return the plaintext."""
    from app.auth.apikey import generate_key

    gen = generate_key()
    session.add(ApiKey(tenant_id=tenant.id, prefix=gen.prefix, key_hash=gen.key_hash, name="test"))
    await session.commit()
    return gen.full_key


@pytest_asyncio.fixture
async def client(tenant):
    """API client with tenant auth + rate limiting overridden (the common case).

    Use ``raw_client`` for tests that exercise the real auth/ratelimit path.
    """
    from app.auth.dependencies import TenantContext, enforce_rate_limit, require_tenant
    from app.main import app

    async def _ctx() -> TenantContext:
        return TenantContext(tenant_id=tenant.id, principal="api_key", rate_limit_per_min=10_000)

    app.dependency_overrides[require_tenant] = _ctx
    app.dependency_overrides[enforce_rate_limit] = lambda: None
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()


@pytest_asyncio.fixture
async def raw_client():
    """API client with NO dependency overrides — real auth + rate limit."""
    from app.main import app

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


# --- helpers ----------------------------------------------------------------
async def make_connection(session, tenant_id, *, kind: str, provider: str, secrets: dict, name=None):
    """Create an encrypted connection row and return it."""
    cid = uuid.uuid4()
    dek = await get_or_create_tenant_dek(session, tenant_id)
    ct, nonce = encrypt_secret(dek, secrets, tenant_id=tenant_id, connection_id=cid, provider_name=provider)
    conn = Connection(
        id=cid, tenant_id=tenant_id, name=name or f"{provider}-conn",
        provider_kind=kind, provider_name=provider, ciphertext=ct, nonce=nonce,
    )
    session.add(conn)
    await session.commit()
    return conn


async def make_full_agent(session, tenant_id):
    """An agent wired to stt/tts/llm/telephony connections (fake but valid secrets)."""
    stt = await make_connection(session, tenant_id, kind="stt", provider="deepgram", secrets={"api_key": "dg"})
    tts = await make_connection(session, tenant_id, kind="tts", provider="cartesia",
                                secrets={"api_key": "cart", "voice_id": "v-123"})
    llm = await make_connection(session, tenant_id, kind="llm", provider="groq", secrets={"api_key": "gsk"})
    tel = await make_connection(session, tenant_id, kind="telephony", provider="twilio",
                                secrets={"account_sid": "AC", "auth_token": "tok", "from_number": "+15550000001"})
    agent = Agent(
        tenant_id=tenant_id, name="Alex", instructions="be helpful",
        stt_connection_id=stt.id, tts_connection_id=tts.id,
        llm_connection_id=llm.id, telephony_connection_id=tel.id,
        provider_settings={"tts": {"model": "sonic-3"}},
    )
    session.add(agent)
    await session.commit()
    await session.refresh(agent)
    return agent


@pytest.fixture(autouse=True)
def cartesia_speaks(monkeypatch):
    """Tests never call Cartesia: its check says the key works unless a test says otherwise."""
    import app.providers.fallback as fallback

    async def ok(_key, _voice):
        return True

    monkeypatch.setattr(fallback, "check_cartesia", ok)
    monkeypatch.setattr(fallback, "_checks", {})
