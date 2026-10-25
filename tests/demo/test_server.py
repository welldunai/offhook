"""The WebSocket route: origin, ticket, claim, run, report — with a fake Worker and runner."""

import json

import httpx
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.demo.config import DemoSettings
from app.demo.server import create_app
from app.demo.signing import make_ticket
from app.demo.worker import WorkerClient

SID = "3b2e6f1c-8a4d-4a8e-9f0b-1c2d3e4f5a6b"
SITE = {"origin": "https://offhook.welldun.ai"}
PLAN = {
    "agent": {"name": "Sam", "company": "Northwind", "role": "recruiter"},
    "person": "the candidate", "brief": "b", "goal": "g", "firstMessage": "Hi", "instructions": "i",
    "assumptions": {}, "fields": [{"key": "interested", "label": "Still interested"}],
}
FULL = dict(DEEPGRAM_API_KEY="d", CARTESIA_API_KEY="c", CARTESIA_VOICE_ID="v", GROQ_API_KEY="g", DEMO_HMAC_SECRET="secret")


class FakeWorker:
    """Records what the server sent to the Worker, and answers claims."""

    def __init__(self, claim_status: int = 200, session_id: str = SID) -> None:
        self.claim_status, self.session_id = claim_status, session_id
        self.requests: list[tuple[str, dict, httpx.Headers]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        self.requests.append((request.url.path, body, request.headers))
        if request.url.path == "/internal/claim":
            if self.claim_status != 200:
                return httpx.Response(self.claim_status, json={"error": "already_claimed"})
            return httpx.Response(200, json={"session_id": self.session_id, "plan": PLAN, "max_seconds": 120, "wrap_up_seconds": 15, "silence_seconds": 20})
        return httpx.Response(200, json={"ok": True})


def make(fake: FakeWorker, settings: DemoSettings | None = None, runs: list | None = None) -> TestClient:
    settings = settings or DemoSettings(**FULL)
    worker = WorkerClient("http://worker.test", settings.hmac_secret, transport=httpx.MockTransport(fake))

    async def runner(call, websocket):
        (runs if runs is not None else []).append(call)
        await websocket.send_text(json.dumps({"type": "transcript", "who": "agent", "text": "Hi"}))
        call.end_reason = "hung_up"

    return TestClient(create_app(settings, worker, runner))


def test_healthz_reports_missing_settings_by_name_only():
    res = make(FakeWorker(), DemoSettings(DEMO_HMAC_SECRET="secret")).get("/healthz")
    assert res.status_code == 503
    assert set(res.json()["missing"]) == {"DEEPGRAM_API_KEY", "CARTESIA_API_KEY", "CARTESIA_VOICE_ID", "GROQ_API_KEY"}
    assert make(FakeWorker()).get("/healthz").json() == {"ok": True, "calls": 0}


def test_a_call_claims_runs_and_reports():
    fake, runs = FakeWorker(), []
    client = make(fake, runs=runs)
    with client.websocket_connect(f"/ws?ticket={make_ticket('secret', SID)}", headers=SITE) as ws:
        assert json.loads(ws.receive_text())["type"] == "transcript"
    assert runs[0].session_id == SID and runs[0].plan == PLAN
    (claim_path, claim_body, claim_headers), (res_path, res_body, _) = fake.requests
    assert claim_path == "/internal/claim" and "x-offhook-signature" in claim_headers
    assert res_path == "/internal/results"
    assert res_body["session_id"] == SID and res_body["end_reason"] == "hung_up"


def test_other_origins_are_refused_before_accepting():
    client = make(FakeWorker())
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f"/ws?ticket={make_ticket('secret', SID)}", headers={"origin": "https://evil.example"}) as ws:
            ws.receive_text()


@pytest.mark.parametrize("ticket", ["", "garbage", make_ticket("wrong-secret", SID)])
def test_bad_tickets_get_a_reason_and_never_reach_the_worker(ticket):
    fake = FakeWorker()
    with make(fake).websocket_connect(f"/ws?ticket={ticket}", headers=SITE) as ws:
        assert json.loads(ws.receive_text())["error"] == "bad_ticket"
    assert fake.requests == []


def test_a_refused_claim_is_explained_and_nothing_runs():
    fake, runs = FakeWorker(claim_status=409), []
    with make(fake, runs=runs).websocket_connect(f"/ws?ticket={make_ticket('secret', SID)}", headers=SITE) as ws:
        msg = json.loads(ws.receive_text())
    assert msg["error"] == "bad_ticket" and "already started" in msg["message"]
    assert runs == [] and [p for p, _, _ in fake.requests] == ["/internal/claim"]


def test_a_claim_for_another_session_is_refused():
    fake, runs = FakeWorker(session_id="someone-else"), []
    with make(fake, runs=runs).websocket_connect(f"/ws?ticket={make_ticket('secret', SID)}", headers=SITE) as ws:
        assert json.loads(ws.receive_text())["error"] == "bad_ticket"
    assert runs == []
