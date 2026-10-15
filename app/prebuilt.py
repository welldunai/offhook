"""Pipecat's prebuilt playground UI — DEV ONLY.

Serves the official Pipecat web client at ``/client`` (rich transcripts /
metrics / event log) and runs browser WebRTC calls against a tenant's stored
agent. Unlike the authed API, the playground has no API key, so it is mounted
only when ``ENABLE_PREBUILT_UI`` is true and ``ENV != prod`` (enforced in
settings). It resolves credentials from a real agent (``DEV_AGENT_ID`` or the
first agent), so even this dev path uses encrypted stored connections — no env
secrets.
"""

from __future__ import annotations

import uuid
from http import HTTPMethod
from typing import Any

from fastapi import BackgroundTasks, FastAPI, Request, Response
from fastapi.responses import RedirectResponse
from sqlalchemy import select

from pipecat_ai_small_webrtc_prebuilt.frontend import SmallWebRTCPrebuiltUI

from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.request_handler import (
    IceCandidate,
    SmallWebRTCPatchRequest,
    SmallWebRTCRequest,
    SmallWebRTCRequestHandler,
)

from app.config import VoiceConfig
from app.db.engine import session_scope
from app.db.models import Agent
from app.logger import logger
from app.runner import run_call
from app.schemas import CallContext
from app.settings import settings
from app.tenancy.resolve import prepare_call, resolve_custom_tools
from app.transport import build_webrtc_transport


async def _resolve_dev_call() -> tuple[CallContext, VoiceConfig, list] | None:
    """Resolve (CallContext, VoiceConfig, custom_tools) for the dev playground agent."""
    async with session_scope() as db:
        agent: Agent | None = None
        if settings.dev_agent_id:
            agent = await db.get(Agent, uuid.UUID(settings.dev_agent_id))
        if agent is None:
            agent = (await db.execute(select(Agent).limit(1))).scalar_one_or_none()
        if agent is None:
            return None
        prepared = await prepare_call(
            db, agent.tenant_id, agent, context={}, metadata={}, need_telephony=False
        )
        tools = await resolve_custom_tools(db, agent.tenant_id, prepared.tool_ids)
        return prepared.call_context, prepared.voice_config, tools


def mount_prebuilt(app: FastAPI) -> None:
    handler = SmallWebRTCRequestHandler()
    active_sessions: dict[str, dict[str, Any]] = {}

    app.mount("/client", SmallWebRTCPrebuiltUI)

    @app.get("/", include_in_schema=False)
    async def root_redirect() -> RedirectResponse:
        return RedirectResponse(url="/client/")

    async def _offer(request: SmallWebRTCRequest, background_tasks: BackgroundTasks) -> Any:
        resolved = await _resolve_dev_call()
        if resolved is None:
            return Response(
                content="No agent configured. Seed a tenant + agent first.", status_code=503
            )
        ctx, cfg, tools = resolved

        async def on_connection(connection: SmallWebRTCConnection) -> None:
            transport = build_webrtc_transport(connection)
            background_tasks.add_task(
                run_call, transport, ctx, cfg, enable_rtvi=True, custom_tools=tools
            )
            logger.info(f"[prebuilt] dev web call starting, agent={ctx.agent.name}")

        return await handler.handle_web_request(
            request=request, webrtc_connection_callback=on_connection
        )

    @app.post("/api/offer", include_in_schema=False)
    async def offer(request: SmallWebRTCRequest, background_tasks: BackgroundTasks) -> Any:
        return await _offer(request, background_tasks)

    @app.patch("/api/offer", include_in_schema=False)
    async def ice_candidate(request: SmallWebRTCPatchRequest) -> dict[str, str]:
        await handler.handle_patch_request(request)
        return {"status": "success"}

    @app.post("/start", include_in_schema=False)
    async def start(request: Request) -> dict[str, Any]:
        try:
            request_data = await request.json()
        except Exception:
            request_data = {}
        session_id = str(uuid.uuid4())
        active_sessions[session_id] = request_data.get("body", {}) or {}
        result: dict[str, Any] = {"sessionId": session_id}
        if request_data.get("enableDefaultIceServers"):
            result["iceConfig"] = {"iceServers": [{"urls": ["stun:stun.l.google.com:19302"]}]}
        return result

    @app.api_route(
        "/sessions/{session_id}/{path:path}",
        methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        include_in_schema=False,
    )
    async def proxy(
        session_id: str, path: str, request: Request, background_tasks: BackgroundTasks
    ) -> Any:
        if session_id not in active_sessions:
            return Response(content="Invalid session", status_code=404)
        if path.endswith("api/offer"):
            data = await request.json()
            if request.method == HTTPMethod.POST.value:
                return await _offer(
                    SmallWebRTCRequest(
                        sdp=data["sdp"], type=data["type"], pc_id=data.get("pc_id"),
                        restart_pc=data.get("restart_pc"),
                        request_data=data.get("request_data") or data.get("requestData"),
                    ),
                    background_tasks,
                )
            if request.method == HTTPMethod.PATCH.value:
                await handler.handle_patch_request(
                    SmallWebRTCPatchRequest(
                        pc_id=data["pc_id"],
                        candidates=[IceCandidate(**c) for c in data.get("candidates", [])],
                    )
                )
                return {"status": "success"}
        return Response(status_code=200)
