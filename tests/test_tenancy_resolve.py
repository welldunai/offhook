"""prepare_call: credential resolution into a VoiceConfig."""
import pytest
from fastapi import HTTPException

from app.db.models import Agent
from app.tenancy.resolve import prepare_call
from tests.conftest import make_connection, make_full_agent


async def test_resolves_voice_id_from_credential(session, tenant):
    agent = await make_full_agent(session, tenant.id)  # tts secret carries voice_id "v-123"
    prepared = await prepare_call(
        session, tenant.id, agent, context={"patient": "Priya"}, metadata={}, need_telephony=True,
    )
    # voice_id lives in the Cartesia credential, surfaced via ResolvedCreds.secret
    assert prepared.voice_config.tts.secret("voice_id") == "v-123"
    assert prepared.voice_config.telephony.provider_name == "twilio"


async def test_context_snapshotted(session, tenant):
    agent = await make_full_agent(session, tenant.id)
    prepared = await prepare_call(
        session, tenant.id, agent, context={"k": "v"}, metadata={}, need_telephony=True,
    )
    assert prepared.call_context.context == {"k": "v"}


async def test_missing_telephony_raises(session, tenant):
    stt = await make_connection(session, tenant.id, kind="stt", provider="deepgram", secrets={"api_key": "d"})
    tts = await make_connection(session, tenant.id, kind="tts", provider="cartesia", secrets={"api_key": "c", "voice_id": "v"})
    llm = await make_connection(session, tenant.id, kind="llm", provider="groq", secrets={"api_key": "g"})
    agent = Agent(tenant_id=tenant.id, name="NoTel", instructions="x",
                  stt_connection_id=stt.id, tts_connection_id=tts.id, llm_connection_id=llm.id)
    session.add(agent)
    await session.commit()
    await session.refresh(agent)
    with pytest.raises(HTTPException) as ei:
        await prepare_call(session, tenant.id, agent, context={}, metadata={}, need_telephony=True)
    assert ei.value.status_code == 409
