"""Calls API + carrier telephony webhooks.

  POST /v1/calls           — place an outbound phone call (tenant-authed).
  GET  /v1/providers       — list supported providers (tenant-authed).
  POST /v1/telephony/answer — Plivo answer webhook (carrier auth via token).
  WS   /v1/telephony/stream — Plivo media stream (carrier auth via token).

Tenant routes are mounted under a router that enforces ``require_tenant``. The
carrier routes are NOT (carriers have no API key); they authenticate via the
single-use ``session_token`` minted when the call was placed.
"""

from __future__ import annotations

import secrets as secretslib
import hashlib
import json
import secrets as secretslib
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response, WebSocket
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app import telephony
from app.api.schemas import CallCreate, CallDetailOut, CallOut
from app.auth.dependencies import TenantContext, require_tenant
from app.config import SUPPORTED_PROVIDERS, VoiceConfig
from app.db import repositories as repo
from app.db.engine import get_session, session_scope
from app.db.models import Call, CallJob, IdempotencyKey, UsageRecord
from app.logger import logger
from app.providers import llm_registry, stt_registry, tts_registry
from app.recording import CallRecorder, save_recording
from app.runner import run_call
from app.settings import settings
from app.tenancy.resolve import (
    call_context_from_snapshot,
    prepare_call,
    resolve_custom_tools,
    voice_config_from_snapshot,
)
from app.events import classify_error, emit_call_event

# Tenant-facing calls + discovery (mounted under require_tenant in main.py).
tenant_router = APIRouter(tags=["calls"])
# Carrier-facing webhooks (no API key; token-authed).
carrier_router = APIRouter(prefix="/telephony", tags=["telephony"])


def _public_base_url(request: Request) -> str:
    base = settings.public_base_url
    if base:
        return base.rstrip("/")
    if settings.is_prod:
        raise HTTPException(status_code=500, detail="PUBLIC_BASE_URL not configured")
    # Dev only: trust the request host (carriers can't reach localhost anyway).
    return str(request.base_url).rstrip("/")


@tenant_router.get("/me")
async def whoami(ctx: TenantContext = Depends(require_tenant)) -> dict[str, Any]:
    """Identify the current principal — the dashboard uses this after sign-in."""
    return {
        "tenant_id": str(ctx.tenant_id),
        "principal": ctx.principal,
        "email": ctx.email,
        "user_id": str(ctx.user_id) if ctx.user_id else None,
    }


@tenant_router.get("/providers")
async def list_providers(_: TenantContext = Depends(require_tenant)) -> dict[str, Any]:
    return {
        "stt": stt_registry.names(),
        "tts": tts_registry.names(),
        "llm": llm_registry.names(),
        "telephony": telephony.telephony_registry.names(),
        "supported": {k: sorted(v) for k, v in SUPPORTED_PROVIDERS.items()},
        # What Offhook supplies itself when an agent leaves a leg empty (None: bring your own).
        "managed": {leg: settings.managed_provider(leg) for leg in ("stt", "tts", "llm")},
    }


def _request_hash(body: CallCreate) -> str:
    payload = json.dumps(body.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()


@tenant_router.post("/calls", response_model=CallOut, status_code=201)
async def create_call(
    body: CallCreate,
    ctx: TenantContext = Depends(require_tenant),
    db: AsyncSession = Depends(get_session),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> Any:
    """Reserve an outbound call and enqueue the dial. Returns immediately with
    status ``queued``; the worker dials and the call progresses via webhooks.
    Honors ``Idempotency-Key`` so a retried request never double-dials."""
    req_hash = _request_hash(body)
    if idempotency_key:
        existing = await repo.get_idempotency(db, ctx.tenant_id, idempotency_key)
        if existing is not None:
            if existing.request_hash != req_hash:
                raise HTTPException(status_code=409, detail="Idempotency-Key reused with a different body")
            return JSONResponse(existing.response_body, status_code=existing.response_code or 201)

    agent = await repo.get_agent(db, ctx.tenant_id, body.agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail="agent not found")

    # Quotas: concurrent live calls and (optional) monthly cap.
    tenant = await repo.get_tenant(db, ctx.tenant_id)
    if await repo.count_active_calls(db, ctx.tenant_id) >= tenant.max_concurrent_calls:
        raise HTTPException(status_code=429, detail="concurrent call limit reached", headers={"Retry-After": "30"})
    if tenant.monthly_call_cap is not None and await repo.count_calls_this_month(db, ctx.tenant_id) >= tenant.monthly_call_cap:
        raise HTTPException(status_code=429, detail="monthly call cap reached")

    # Resolve creds now (validates connections) and snapshot the non-secret context.
    prepared = await prepare_call(
        db, ctx.tenant_id, agent,
        context=body.context, metadata=body.metadata, need_telephony=True,
    )

    token = secretslib.token_urlsafe(32)
    snapshot = {
        "agent": prepared.call_context.agent.model_dump(),
        "context": body.context,
        "metadata": body.metadata,
        "connections": prepared.conn_ids,
        "settings": prepared.settings,
        "tool_ids": prepared.tool_ids,
        "language": prepared.voice_config.language,
        "from_number": body.from_number,
        "telephony_provider": prepared.voice_config.telephony.provider_name if prepared.voice_config.telephony else "plivo",
    }
    call = Call(
        tenant_id=ctx.tenant_id, agent_id=agent.id, direction="outbound",
        status="queued", to_number=body.to_number, from_number=body.from_number,
        tags=body.tags, session_token=token, call_context_snapshot=snapshot,
    )
    db.add(call)
    await db.flush()

    db.add(CallJob(tenant_id=ctx.tenant_id, call_id=call.id, kind="dial"))
    await emit_call_event(db, ctx.tenant_id, call.id, "call.queued",
                          {"status": "queued", "to": body.to_number})

    resp = CallOut(id=call.id, status="queued", direction="outbound", provider_call_id=None)
    if idempotency_key:
        db.add(IdempotencyKey(
            tenant_id=ctx.tenant_id, key=idempotency_key, request_hash=req_hash,
            response_code=201, response_body=resp.model_dump(mode="json"),
        ))
        try:
            await db.flush()
        except IntegrityError:  # concurrent same-key request won the race
            await db.rollback()
            existing = await repo.get_idempotency(db, ctx.tenant_id, idempotency_key)
            if existing is not None:
                return JSONResponse(existing.response_body, status_code=existing.response_code or 201)
            raise
    logger.info(f"[calls] queued outbound call {call.id} (tenant={ctx.tenant_id})")
    return resp


@tenant_router.get("/calls/{call_id}", response_model=CallDetailOut)
async def get_call(
    call_id: uuid.UUID,
    ctx: TenantContext = Depends(require_tenant),
    db: AsyncSession = Depends(get_session),
) -> CallDetailOut:
    call = await repo.get_call(db, ctx.tenant_id, call_id)
    if call is None:
        raise HTTPException(status_code=404, detail="call not found")
    out = CallDetailOut.model_validate(call, from_attributes=True)
    out.has_recording = bool(call.recording_path)
    return out


@tenant_router.get("/calls/{call_id}/recording")
async def get_call_recording(
    call_id: uuid.UUID,
    ctx: TenantContext = Depends(require_tenant),
    db: AsyncSession = Depends(get_session),
) -> FileResponse:
    """Stream the call's audio recording (WAV)."""
    call = await repo.get_call(db, ctx.tenant_id, call_id)
    if call is None or not call.recording_path:
        raise HTTPException(status_code=404, detail="recording not found")
    import os

    if not os.path.exists(call.recording_path):
        raise HTTPException(status_code=404, detail="recording file missing")
    return FileResponse(call.recording_path, media_type="audio/wav", filename=f"call-{call_id}.wav")


# ---- carrier webhooks (token-authed) ------------------------------------


async def _lookup_call(db: AsyncSession, token: str | None, *, consume: bool) -> Call:
    if not token:
        raise HTTPException(status_code=403, detail="missing session token")
    call = await repo.get_call_by_session_token(db, token)
    if call is None or call.session_consumed_at is not None:
        raise HTTPException(status_code=403, detail="invalid or used session token")
    if consume:
        call.session_consumed_at = datetime.now(timezone.utc)
        await db.flush()
    return call


@carrier_router.post("/answer")
async def telephony_answer(
    request: Request,
    session_token: str | None = None,
    db: AsyncSession = Depends(get_session),
) -> Response:
    # Answer is the first hop; do NOT consume the token yet (the stream needs it).
    call = await _lookup_call(db, session_token, consume=False)
    provider = telephony.get_provider(call.call_context_snapshot.get("telephony_provider", "plivo"))

    base = _public_base_url(request)
    ws_scheme = "wss" if base.startswith("https") else "ws"
    host = base.split("://", 1)[-1]
    ws_url = f"{ws_scheme}://{host}/v1/telephony/stream?session_token={session_token}"

    body, media_type = provider.answer_document(ws_url)
    logger.info(f"[telephony] answer for call {call.id}")
    return Response(content=body, media_type=media_type)


@carrier_router.post("/inbound")
async def telephony_inbound(
    request: Request,
    db: AsyncSession = Depends(get_session),
) -> Response:
    """Inbound answer webhook — route a dialed number to its agent.

    Plivo POSTs form data (``To``/``From``) when a call hits a number whose
    answer URL is this endpoint. We map ``To`` → agent, verify the Plivo
    signature, reserve a call, and return the media-stream document.
    """
    form = await request.form()
    to = form.get("To") or form.get("to")
    frm = form.get("From") or form.get("from")
    if not to:
        raise HTTPException(status_code=400, detail="missing To")

    pn = await repo.get_phone_number_by_e164(db, str(to))
    if pn is None:
        raise HTTPException(status_code=404, detail="number not provisioned")
    agent = await repo.get_agent(db, pn.tenant_id, pn.agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail="agent not found for number")

    prepared = await prepare_call(
        db, pn.tenant_id, agent,
        context={"caller": str(frm) if frm else None},
        metadata={"direction": "inbound"}, need_telephony=True,
    )

    provider = telephony.get_provider(prepared.voice_config.telephony.provider_name)
    inbound_url = f"{_public_base_url(request)}/v1/telephony/inbound"
    if not provider.verify_webhook(
        method="POST", url=inbound_url, params={k: str(v) for k, v in form.items()},
        headers=dict(request.headers), creds=prepared.voice_config.telephony,
    ):
        raise HTTPException(status_code=403, detail="invalid signature")

    token = secretslib.token_urlsafe(32)
    snapshot = {
        "agent": prepared.call_context.agent.model_dump(),
        "context": {"caller": str(frm) if frm else None},
        "metadata": {"direction": "inbound"},
        "connections": prepared.conn_ids,
        "settings": prepared.settings,
        "tool_ids": prepared.tool_ids,
        "language": prepared.voice_config.language,
        "telephony_provider": prepared.voice_config.telephony.provider_name if prepared.voice_config.telephony else "plivo",
    }
    call = Call(
        tenant_id=pn.tenant_id, agent_id=agent.id, direction="inbound",
        status="reserved", to_number=str(to), from_number=str(frm) if frm else None,
        session_token=token, call_context_snapshot=snapshot,
    )
    db.add(call)
    await db.flush()
    await emit_call_event(db, pn.tenant_id, call.id, "call.received",
                          {"status": "reserved", "from": str(frm) if frm else None, "to": str(to)})

    base = _public_base_url(request)
    ws_scheme = "wss" if base.startswith("https") else "ws"
    host = base.split("://", 1)[-1]
    ws_url = f"{ws_scheme}://{host}/v1/telephony/stream?session_token={token}"
    body, media_type = provider.answer_document(ws_url)
    logger.info(f"[telephony] inbound call {call.id} for {to} -> agent {agent.id}")
    return Response(content=body, media_type=media_type)


# Carrier hangup cause/status → stable error code. Covers Plivo HangupCause and
# Twilio CallStatus (normalized to UPPER with '-' → '_').
_HANGUP_CODES = {
    "NORMAL_CLEARING": None, "NORMAL": None, "COMPLETED": None,
    "USER_BUSY": "busy", "BUSY_LINE": "busy", "BUSY": "busy",
    "NO_ANSWER": "no_answer", "NO_USER_RESPONSE": "no_answer", "TIMEOUT": "no_answer",
    "REJECTED": "rejected", "CALL_REJECTED": "rejected", "CANCELED": "rejected",
    "UNALLOCATED_NUMBER": "invalid_number",
    "FAILED": "carrier_error",
}


@carrier_router.post("/status")
async def telephony_status(
    request: Request,
    session_token: str | None = None,
    db: AsyncSession = Depends(get_session),
) -> Response:
    """Carrier hangup callback — record the cause/code on the call's timeline.

    Authenticated by the unguessable per-call token. Marks calls that never
    connected (busy/no-answer) as failed with the carrier's reason.
    """
    if not session_token:
        return Response(status_code=403)
    call = await repo.get_call_by_session_token(db, session_token)
    if call is None:
        return Response(status_code=200)  # unknown/expired — ignore

    form = await request.form()
    # Plivo → HangupCause; Twilio → CallStatus.
    raw = str(form.get("HangupCause") or form.get("CallStatus") or form.get("hangup_cause") or "")
    cause = raw.upper().replace("-", "_")
    code = _HANGUP_CODES.get(cause, "carrier_error" if cause and cause not in ("NORMAL_CLEARING", "NORMAL", "COMPLETED") else None)
    duration = form.get("Duration") or form.get("BillDuration") or form.get("CallDuration")

    await emit_call_event(
        db, call.tenant_id, call.id, "carrier.hangup",
        {"cause": cause, "hangup_code": form.get("HangupCauseCode"), "duration": duration},
        error_code=code,
    )
    # If our media stream never ran (call still pre-connect when the carrier's
    # final status arrives), finalize it from the carrier signal so it doesn't
    # dangle at "dialing". A clean carrier "completed" with no media means the
    # call connected at the carrier but our app never ran (e.g. a Twilio trial
    # call where the callee didn't press a key) → mark it failed with "no_media".
    if call.status in ("queued", "dialing", "reserved"):
        final_code = code or "no_media"
        call.status = "failed"
        call.error = f"carrier: {cause or 'no media'}"
        call.error_code = final_code
        call.ended_at = datetime.now(timezone.utc)
        await emit_call_event(db, call.tenant_id, call.id, "call.failed",
                              {"status": "failed", "cause": cause}, error_code=final_code)
    logger.info(f"[telephony] status for call {call.id}: {cause} -> {code}")
    return Response(status_code=200)


@carrier_router.websocket("/stream")
async def telephony_stream(websocket: WebSocket, session_token: str | None = None) -> None:
    await websocket.accept()

    # Read the carrier's first JSON messages until the "start" event. Both Plivo
    # and Twilio send an event=="start" message. Twilio drops the URL query
    # string, so the session token may arrive only via start.customParameters.
    start_msg = None
    try:
        for _ in range(6):
            msg = await websocket.receive_json()
            if msg.get("event") == "start":
                start_msg = msg
                break
    except Exception:
        await websocket.close()
        return
    if start_msg is None:
        await websocket.close()
        return

    token = session_token or (start_msg.get("start", {}).get("customParameters", {}) or {}).get("session_token")

    # Consume the token and load the call (+ re-resolve creds) in a short txn.
    async with session_scope() as db:
        try:
            call = await _lookup_call(db, token, consume=True)
        except HTTPException:
            await websocket.close()
            return
        call_id = call.id
        tenant_id = call.tenant_id
        snapshot = call.call_context_snapshot
        voice_config: VoiceConfig = await voice_config_from_snapshot(
            db, tenant_id, snapshot, need_telephony=True
        )
        custom_tools = await resolve_custom_tools(db, tenant_id, snapshot.get("tool_ids"))
        call.status = "in_progress"
        call.started_at = datetime.now(timezone.utc)
        await emit_call_event(db, tenant_id, call_id, "call.in_progress", {"status": "in_progress"})

    provider = telephony.get_provider(voice_config.telephony.provider_name)
    start = provider.parse_stream_start(start_msg)
    if start is None:
        await websocket.close()
        return

    transport = provider.build_transport(websocket, start, creds=voice_config.telephony)
    ctx = call_context_from_snapshot(snapshot)
    logger.info(f"[telephony] stream start for call {call_id}")
    recorder = CallRecorder()
    outcome: Any = None
    error: str | None = None
    try:
        outcome = await run_call(transport, ctx, voice_config, recorder=recorder, custom_tools=custom_tools)
    except Exception as exc:  # noqa: BLE001
        error = str(exc)
        logger.exception("[telephony] pipeline crashed")

    # Persist the call audio (best-effort).
    rec_path = None
    try:
        rec_path = save_recording(tenant_id, call_id, recorder)
    except Exception:  # noqa: BLE001
        logger.exception("[telephony] failed to save recording")

    async with session_scope() as db:
        call = await repo.get_call(db, tenant_id, call_id)
        if call is not None:
            final = "failed" if error else "completed"
            ended = datetime.now(timezone.utc)
            call.status = final
            call.error = error
            call.error_code = classify_error(error) if error else None
            call.recording_path = rec_path
            outcome_dump = outcome.model_dump() if outcome is not None else None
            call.outcome = outcome_dump
            # Persist the conversation content (the "raw call log" body).
            transcript = outcome.transcript if outcome is not None else []
            call.transcript = transcript
            call.ended_at = ended
            duration = None
            if call.started_at is not None:
                duration = max(0, int((ended - call.started_at).total_seconds() + 0.999))
                db.add(UsageRecord(tenant_id=tenant_id, call_id=call_id, kind="call", seconds=duration))
            await emit_call_event(
                db, tenant_id, call_id, f"call.{final}",
                {"status": final, "summary": (outcome_dump or {}).get("summary"),
                 "duration_seconds": duration, "turns": len(transcript), "error": error},
                error_code=call.error_code,
            )
