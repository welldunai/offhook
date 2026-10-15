"""Webhook endpoint registration — secret shown once, write-only thereafter."""


async def test_create_returns_secret_once(client):
    r = await client.post("/v1/webhooks", json={"url": "https://1.1.1.1/hook", "events": []})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["secret"].startswith("whsec_")
    assert body["url"] == "https://1.1.1.1/hook"


async def test_list_does_not_expose_secret(client):
    await client.post("/v1/webhooks", json={"url": "https://1.1.1.1/hook", "events": ["call.completed"]})
    lst = await client.get("/v1/webhooks")
    assert lst.status_code == 200 and len(lst.json()) == 1
    assert "secret" not in lst.json()[0]


async def test_rejects_internal_url(client):
    r = await client.post("/v1/webhooks", json={"url": "http://169.254.169.254/x", "events": []})
    assert r.status_code == 422


async def test_delete(client):
    wid = (await client.post("/v1/webhooks", json={"url": "https://8.8.8.8/h", "events": []})).json()["id"]
    assert (await client.delete(f"/v1/webhooks/{wid}")).status_code in (200, 204)
