"""WorkerClient.stats: a signed POST to /internal/stats."""

import json

import httpx
import pytest

from app.demo.signing import sign_request
from app.demo.worker import WorkerClient


async def test_stats_is_signed_and_returns_the_body():
    seen = {}

    def handle(req: httpx.Request) -> httpx.Response:
        seen["path"], seen["body"] = req.url.path, req.content.decode()
        expected = sign_request("secret", seen["body"], float(req.headers["x-offhook-timestamp"]))
        seen["ok"] = req.headers["x-offhook-signature"] == expected["x-offhook-signature"]
        return httpx.Response(200, json={"days": [], "use_cases": {}})

    client = WorkerClient("http://worker.test", "secret", transport=httpx.MockTransport(handle))
    assert await client.stats(7) == {"days": [], "use_cases": {}}
    assert seen["path"] == "/internal/stats" and json.loads(seen["body"]) == {"days": 7} and seen["ok"]


async def test_stats_raises_when_refused():
    client = WorkerClient("http://worker.test", "secret", transport=httpx.MockTransport(lambda r: httpx.Response(401)))
    with pytest.raises(httpx.HTTPStatusError):
        await client.stats(7)
