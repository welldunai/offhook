"""Offhook's own providers: an agent can leave STT/TTS/LLM empty and run on them."""

import pytest

from app.settings import settings
from app.tenancy.resolve import prepare_call
from tests.conftest import make_connection

PLATFORM = {
    "platform_deepgram_api_key": "dg-platform",
    "platform_cartesia_api_key": "cart-platform",
    "platform_cartesia_voice_id": "voice-platform",
    "platform_groq_api_key": "gsk-platform",
}


@pytest.fixture
def platform(monkeypatch):
    for k, v in PLATFORM.items():
        monkeypatch.setattr(settings, k, v)


@pytest.fixture
def no_platform(monkeypatch):
    for k in PLATFORM:
        monkeypatch.setattr(settings, k, None)


AGENT = {"name": "Sam", "instructions": "Screen the candidate.", "first_message": "Hi, this is Sam."}


async def test_an_agent_with_no_keys_runs_on_offhooks(client, session, tenant, platform):
    r = await client.post("/v1/agents", json=AGENT)
    assert r.status_code == 201, r.text
    from app.db.models import Agent

    agent = await session.get(Agent, __import__("uuid").UUID(r.json()["id"]))
    prepared = await prepare_call(session, tenant.id, agent, context={}, metadata={}, need_telephony=False)
    cfg = prepared.voice_config
    assert (cfg.stt.provider_name, cfg.stt.secret("api_key")) == ("deepgram", "dg-platform")
    assert (cfg.tts.provider_name, cfg.tts.secret("voice_id")) == ("cartesia", "voice-platform")
    assert (cfg.llm.provider_name, cfg.llm.secret("api_key")) == ("groq", "gsk-platform")


async def test_without_offhooks_keys_an_agent_must_bring_its_own(client, no_platform):
    r = await client.post("/v1/agents", json=AGENT)
    assert r.status_code == 422
    assert "stt" in r.json()["detail"]


async def test_own_connections_win_and_settings_still_apply(client, session, tenant, platform):
    own_llm = await make_connection(session, tenant.id, kind="llm", provider="groq", secrets={"api_key": "gsk-mine"})
    r = await client.post("/v1/agents", json={**AGENT, "llm_connection_id": str(own_llm.id),
                                              "llm_model": "openai/gpt-oss-120b", "voice_id": "my-voice"})
    assert r.status_code == 201, r.text
    from app.db.models import Agent

    agent = await session.get(Agent, __import__("uuid").UUID(r.json()["id"]))
    cfg = (await prepare_call(session, tenant.id, agent, context={}, metadata={}, need_telephony=False)).voice_config
    assert cfg.llm.secret("api_key") == "gsk-mine" and cfg.llm.setting("model") == "openai/gpt-oss-120b"
    assert cfg.stt.secret("api_key") == "dg-platform"
    assert cfg.tts.setting("voice_id") == "my-voice"  # the agent's voice, on Offhook's Cartesia


async def test_a_phone_call_still_needs_the_workspaces_own_line(client, session, tenant, platform):
    r = await client.post("/v1/agents", json=AGENT)
    from app.db.models import Agent

    agent = await session.get(Agent, __import__("uuid").UUID(r.json()["id"]))
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as e:
        await prepare_call(session, tenant.id, agent, context={}, metadata={}, need_telephony=True)
    assert e.value.status_code == 409 and "telephony" in e.value.detail


async def test_providers_says_what_offhook_supplies(client, platform, monkeypatch):
    monkeypatch.setattr(settings, "platform_cartesia_voice_id", None)  # TTS needs a voice too
    body = (await client.get("/v1/providers")).json()
    assert body["managed"] == {"stt": "deepgram", "tts": None, "llm": "groq"}
