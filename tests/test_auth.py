"""Real API-key auth path + cross-tenant isolation (no dependency overrides)."""
import uuid

import pytest
from sqlalchemy import update

from app.db.models import ApiKey
from tests.conftest import make_connection


async def test_valid_key_authorized(raw_client, api_key):
    r = await raw_client.get("/v1/connections", headers={"Authorization": f"Bearer {api_key}"})
    assert r.status_code == 200
    assert r.json() == []


async def test_missing_credentials_rejected(raw_client):
    r = await raw_client.get("/v1/connections")
    assert r.status_code == 401


async def test_garbage_key_rejected(raw_client):
    r = await raw_client.get("/v1/connections", headers={"Authorization": "Bearer not-a-key"})
    assert r.status_code == 401


async def test_wrong_secret_rejected(raw_client, api_key):
    # right prefix, wrong secret
    prefix = api_key.split("_")[2]
    forged = f"vk_dev_{prefix}_wrongsecretwrongsecret"
    r = await raw_client.get("/v1/connections", headers={"Authorization": f"Bearer {forged}"})
    assert r.status_code == 401


async def test_revoked_key_rejected(raw_client, api_key, session):
    from datetime import datetime, timezone

    prefix = api_key.split("_")[2]
    await session.execute(
        update(ApiKey).where(ApiKey.prefix == prefix).values(revoked_at=datetime.now(timezone.utc))
    )
    await session.commit()
    r = await raw_client.get("/v1/connections", headers={"Authorization": f"Bearer {api_key}"})
    assert r.status_code == 401


async def test_x_api_key_header_accepted(raw_client, api_key):
    r = await raw_client.get("/v1/connections", headers={"X-API-Key": api_key})
    assert r.status_code == 200


async def test_cross_tenant_isolation(raw_client, api_key, tenant, session):
    """Tenant A's key must not see tenant B's connections."""
    from app.db.models import Tenant

    other = Tenant(name="Other", slug=f"other-{uuid.uuid4().hex[:8]}")
    session.add(other)
    await session.commit()
    await make_connection(session, other.id, kind="llm", provider="groq", secrets={"api_key": "x"})

    r = await raw_client.get("/v1/connections", headers={"Authorization": f"Bearer {api_key}"})
    assert r.status_code == 200
    assert r.json() == []  # A sees none of B's
