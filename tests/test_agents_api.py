"""Agents CRUD and connection-reference validation."""


async def _mk_conn(client, kind, provider, secrets):
    r = await client.post("/v1/connections", json={
        "name": f"{provider}-{kind}", "provider_kind": kind,
        "provider_name": provider, "secrets": secrets})
    assert r.status_code == 201, r.text
    return r.json()["id"]


async def _agent_body(client):
    return {
        "name": "Alex", "instructions": "be helpful",
        "stt_connection_id": await _mk_conn(client, "stt", "deepgram", {"api_key": "d"}),
        "tts_connection_id": await _mk_conn(client, "tts", "cartesia", {"api_key": "c", "voice_id": "v"}),
        "llm_connection_id": await _mk_conn(client, "llm", "groq", {"api_key": "g"}),
    }


async def test_create_and_list(client):
    r = await client.post("/v1/agents", json=await _agent_body(client))
    assert r.status_code == 201, r.text
    assert r.json()["name"] == "Alex"
    lst = await client.get("/v1/agents")
    assert lst.status_code == 200 and len(lst.json()) == 1


async def test_rejects_wrong_kind_connection(client):
    body = await _agent_body(client)
    # point stt at the llm connection
    body["stt_connection_id"] = body["llm_connection_id"]
    r = await client.post("/v1/agents", json=body)
    assert r.status_code == 422


async def test_rejects_missing_connection(client):
    import uuid
    body = await _agent_body(client)
    body["llm_connection_id"] = str(uuid.uuid4())
    r = await client.post("/v1/agents", json=body)
    assert r.status_code == 422


async def test_delete(client):
    aid = (await client.post("/v1/agents", json=await _agent_body(client))).json()["id"]
    assert (await client.delete(f"/v1/agents/{aid}")).status_code in (200, 204)
    assert (await client.get(f"/v1/agents/{aid}")).status_code == 404
