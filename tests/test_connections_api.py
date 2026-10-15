"""Connections CRUD: provider validation, write-only secrets, tenant scoping."""


async def _create(client, **over):
    body = {"name": "my-groq", "provider_kind": "llm", "provider_name": "groq",
            "secrets": {"api_key": "gsk_secret"}}
    body.update(over)
    return await client.post("/v1/connections", json=body)


async def test_create_returns_no_secrets(client):
    r = await _create(client)
    assert r.status_code == 201
    data = r.json()
    assert data["provider_name"] == "groq" and data["provider_kind"] == "llm"
    assert "secrets" not in data and "api_key" not in str(data)


async def test_list_and_get(client):
    cid = (await _create(client)).json()["id"]
    lst = await client.get("/v1/connections")
    assert lst.status_code == 200 and len(lst.json()) == 1
    one = await client.get(f"/v1/connections/{cid}")
    assert one.status_code == 200 and one.json()["id"] == cid


async def test_rejects_unsupported_provider(client):
    r = await _create(client, provider_name="not-a-provider")
    assert r.status_code == 422


async def test_rejects_provider_kind_mismatch(client):
    # cartesia is a TTS provider, not LLM
    r = await _create(client, provider_kind="llm", provider_name="cartesia")
    assert r.status_code == 422


async def test_duplicate_name_conflict(client):
    await _create(client, name="dupe")
    r = await _create(client, name="dupe", provider_name="groq")
    assert r.status_code == 409


async def test_update_secret_and_name(client):
    cid = (await _create(client)).json()["id"]
    r = await client.patch(f"/v1/connections/{cid}", json={"name": "renamed", "secrets": {"api_key": "new"}})
    assert r.status_code == 200 and r.json()["name"] == "renamed"


async def test_delete(client):
    cid = (await _create(client)).json()["id"]
    assert (await client.delete(f"/v1/connections/{cid}")).status_code in (200, 204)
    assert (await client.get(f"/v1/connections/{cid}")).status_code == 404
