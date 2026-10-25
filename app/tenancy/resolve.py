"""Resolve a tenant's agent + stored connections into a runnable call.

Turns the persisted, encrypted world (agent row + connection rows) into the
in-memory ``CallContext`` (no secrets) and ``VoiceConfig`` (decrypted creds per
leg) the pipeline needs. Decryption happens here and nowhere else on the call
path; the decrypted creds live only for the duration of the call and are never
logged or persisted.

Two entry points:
  * ``prepare_call`` — at reserve/offer time, from an ``Agent`` row.
  * ``voice_config_from_snapshot`` — at carrier media-stream time, from the
    frozen ``calls.call_context_snapshot`` (so we re-decrypt rather than ever
    storing plaintext creds).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import ResolvedCreds, VoiceConfig
from app.settings import settings as app_settings
from app.crypto.envelope import decrypt_secret, get_or_create_tenant_dek
from app.db import repositories as repo
from app.db.models import Agent
from app.schemas import AgentConfig, CallContext
from app.tools.http_tool import ResolvedTool

_LEGS = ("stt", "tts", "llm", "telephony")


@dataclass
class PreparedCall:
    call_context: CallContext
    voice_config: VoiceConfig
    # Persisted into the call snapshot so the stream handler can re-resolve.
    conn_ids: dict[str, str]
    settings: dict[str, dict]
    tool_ids: list[str]


def _agent_to_config(agent: Agent) -> AgentConfig:
    return AgentConfig(
        name=agent.name,
        company=agent.company,
        role=agent.role,
        instructions=agent.instructions,
        first_message=agent.first_message,
        voice_id=agent.voice_id,
        llm_model=agent.llm_model,
    )


def _leg_settings(agent: Agent, leg: str) -> dict:
    """Non-secret tunables for one leg: agent.provider_settings[leg] + overrides."""
    base = dict((agent.provider_settings or {}).get(leg, {}))
    if leg == "tts" and agent.voice_id:
        base["voice_id"] = agent.voice_id
    if leg == "llm" and agent.llm_model:
        base["model"] = agent.llm_model
    return base


async def _resolve_leg(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    dek: bytes,
    conn_id: uuid.UUID,
    settings: dict,
    expected_kind: str,
) -> ResolvedCreds:
    conn = await repo.get_connection(db, tenant_id, conn_id)
    if conn is None:
        raise HTTPException(status_code=409, detail=f"{expected_kind} connection not found")
    if conn.provider_kind != expected_kind:
        raise HTTPException(
            status_code=409,
            detail=f"connection {conn.name!r} is {conn.provider_kind}, expected {expected_kind}",
        )
    secrets = decrypt_secret(
        dek, conn.ciphertext, conn.nonce,
        tenant_id=tenant_id, connection_id=conn.id, provider_name=conn.provider_name,
    )
    return ResolvedCreds(provider_name=conn.provider_name, secrets=secrets, settings=settings)


def _managed_leg(leg: str, settings: dict) -> ResolvedCreds | None:
    """Offhook's own credentials for a leg the agent left empty, if this server has them.

    Args:
        leg: "stt", "tts" or "llm".
        settings: The agent's non-secret settings for the leg (model, voice, …).

    Returns:
        Resolved credentials, or None if Offhook doesn't supply this leg here.
    """
    provider = app_settings.managed_provider(leg)
    if provider == "deepgram":
        return ResolvedCreds("deepgram", {"api_key": app_settings.platform_deepgram_api_key}, settings)
    if provider == "cartesia":
        secrets = {"api_key": app_settings.platform_cartesia_api_key, "voice_id": app_settings.platform_cartesia_voice_id}
        return ResolvedCreds("cartesia", secrets, settings)
    if provider == "groq":
        return ResolvedCreds("groq", {"api_key": app_settings.platform_groq_api_key}, settings)
    return None


async def _build_voice_config(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    conn_ids: dict[str, uuid.UUID | None],
    settings: dict[str, dict],
    *,
    need_telephony: bool,
    language: str = "en",
) -> VoiceConfig:
    # An empty stt/tts/llm connection means "use Offhook's" (settings.PLATFORM_*).
    managed = {}
    for leg in ("stt", "tts", "llm"):
        if not conn_ids.get(leg):
            managed[leg] = _managed_leg(leg, settings.get(leg, {}))
            if managed[leg] is None:
                raise HTTPException(status_code=409, detail=f"agent has no {leg} connection")
    if need_telephony and not conn_ids.get("telephony"):
        raise HTTPException(status_code=409, detail="agent has no telephony connection")

    dek = await get_or_create_tenant_dek(db, tenant_id)

    async def leg_creds(leg: str) -> ResolvedCreds:
        if leg in managed:
            return managed[leg]
        return await _resolve_leg(db, tenant_id, dek, conn_ids[leg], settings.get(leg, {}), leg)

    stt = await leg_creds("stt")
    tts = await leg_creds("tts")
    llm = await leg_creds("llm")
    telephony = None
    if conn_ids.get("telephony"):
        telephony = await _resolve_leg(
            db, tenant_id, dek, conn_ids["telephony"], settings.get("telephony", {}), "telephony"
        )
    return VoiceConfig(stt=stt, tts=tts, llm=llm, telephony=telephony, language=language)


async def prepare_call(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    agent: Agent,
    *,
    context: dict,
    metadata: dict,
    need_telephony: bool,
) -> PreparedCall:
    conn_ids: dict[str, uuid.UUID | None] = {
        "stt": agent.stt_connection_id,
        "tts": agent.tts_connection_id,
        "llm": agent.llm_connection_id,
        "telephony": agent.telephony_connection_id,
    }
    settings = {leg: _leg_settings(agent, leg) for leg in _LEGS}
    language = (agent.provider_settings or {}).get("language", "en")

    voice_config = await _build_voice_config(
        db, tenant_id, conn_ids, settings, need_telephony=need_telephony, language=language
    )
    call_context = CallContext(
        agent=_agent_to_config(agent), context=context or {}, metadata=metadata or {}
    )
    return PreparedCall(
        call_context=call_context,
        voice_config=voice_config,
        conn_ids={k: str(v) for k, v in conn_ids.items() if v},
        settings=settings,
        tool_ids=[str(t) for t in (agent.tool_ids or [])],
    )


def call_context_from_snapshot(snapshot: dict) -> CallContext:
    return CallContext(
        agent=AgentConfig(**snapshot["agent"]),
        context=snapshot.get("context", {}),
        metadata=snapshot.get("metadata", {}),
    )


async def voice_config_from_snapshot(
    db: AsyncSession, tenant_id: uuid.UUID, snapshot: dict, *, need_telephony: bool
) -> VoiceConfig:
    conn_ids = {leg: (uuid.UUID(v) if v else None) for leg, v in snapshot.get("connections", {}).items()}
    for leg in _LEGS:
        conn_ids.setdefault(leg, None)
    return await _build_voice_config(
        db, tenant_id, conn_ids, snapshot.get("settings", {}),
        need_telephony=need_telephony, language=snapshot.get("language", "en"),
    )


async def resolve_custom_tools(
    db: AsyncSession, tenant_id: uuid.UUID, tool_ids: list[str] | None
) -> list[ResolvedTool]:
    """Load the agent's custom tools and decrypt their auth headers.

    Mirrors connection resolution: tool ids are frozen in the call snapshot and
    re-resolved (re-decrypted) here at call time — plaintext headers are never
    stored. Skips tools that have since been deleted.
    """
    if not tool_ids:
        return []
    uuids = [uuid.UUID(t) for t in tool_ids]
    rows = await repo.get_custom_tools_by_ids(db, tenant_id, uuids)
    if not rows:
        return []

    dek = await get_or_create_tenant_dek(db, tenant_id)
    resolved: list[ResolvedTool] = []
    for row in rows:
        headers: dict = {}
        if row.headers_ciphertext and row.headers_nonce:
            headers = decrypt_secret(
                dek, row.headers_ciphertext, row.headers_nonce,
                tenant_id=tenant_id, connection_id=row.id, provider_name="tool",
            )
        resolved.append(
            ResolvedTool(
                name=row.name,
                description=row.description,
                parameters=row.parameters or {},
                method=row.method,
                url=row.url,
                headers={str(k): str(v) for k, v in headers.items()},
                timeout_seconds=float(row.timeout_seconds or 10),
            )
        )
    return resolved
