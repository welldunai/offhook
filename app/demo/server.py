"""The demo voice server: one health route and one WebSocket route.

Run it with ``python -m app.demo`` (see ``app/demo/__main__.py``). It is meant to
sit behind a Cloudflare Tunnel as ``voice.offhook.welldun.ai``; nothing else
about the machine is exposed.

A connection's life:
  1. Check the page's Origin, accept, and read ``?ticket=``.
  2. Check the ticket's signature and expiry locally, then claim it from the
     Worker, which hands over the plan exactly once.
  3. Run the call (``DemoCall``) over the socket.
  4. Report the results to the Worker, which frees the line.
"""

from __future__ import annotations

import json
from typing import Any, Awaitable, Callable

from fastapi import FastAPI, WebSocket
from fastapi.responses import JSONResponse
from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams, FastAPIWebsocketTransport

from app.demo.call import DemoCall, Limits, voice_config
from app.demo.config import DemoSettings
from app.demo.serializer import SAMPLE_RATE, DemoSerializer
from app.demo.signing import read_ticket
from app.demo.worker import ClaimRefused, WorkerClient
from app.logger import logger

#: Runs a claimed call over a socket; tests replace it.
CallRunner = Callable[[DemoCall, WebSocket], Awaitable[None]]


async def run_over_socket(call: DemoCall, websocket: WebSocket) -> None:
    """Run ``call`` with Pipecat's FastAPI WebSocket transport and the demo wire format.

    Args:
        call: The claimed call.
        websocket: The accepted browser socket.
    """
    transport = FastAPIWebsocketTransport(
        websocket,
        FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_in_sample_rate=SAMPLE_RATE,
            audio_out_sample_rate=SAMPLE_RATE,
            serializer=DemoSerializer(),
        ),
    )
    await call.run(transport)


def create_app(
    settings: DemoSettings,
    worker: WorkerClient | None = None,
    runner: CallRunner = run_over_socket,
) -> FastAPI:
    """Build the server.

    Args:
        settings: Keys, the shared secret, the Worker URL and allowed origins.
        worker: The Worker client; built from settings when omitted.
        runner: Runs a claimed call; tests pass a fake.

    Returns:
        The FastAPI app.
    """
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    worker = worker or WorkerClient(settings.worker_url, settings.hmac_secret)
    origins = settings.origins()
    state = {"active": 0}

    @app.get("/healthz")
    async def healthz() -> JSONResponse:
        """Up only when every required setting is present, so the Worker shows "offline" otherwise."""
        missing = settings.missing()
        if missing:
            return JSONResponse({"ok": False, "missing": missing}, status_code=503)
        return JSONResponse({"ok": True, "calls": state["active"]})

    @app.websocket("/ws")
    async def call_socket(websocket: WebSocket) -> None:
        """One demo call. See the module docstring for the steps."""
        if websocket.headers.get("origin") not in origins:
            await websocket.close(code=1008)
            return
        await websocket.accept()

        ticket = websocket.query_params.get("ticket")
        session_id = read_ticket(settings.hmac_secret, ticket)
        if session_id is None:
            return await _refuse(websocket, "bad_ticket", "This call link has expired. Start the call again.")
        if state["active"] >= settings.max_local_calls:
            return await _refuse(websocket, "lines_busy", "All lines are busy. Try again in a minute.")
        try:
            claimed = await worker.claim(ticket or "")
        except ClaimRefused as e:
            logger.info(f"[demo] claim refused for {session_id}: {e.status} {e.error}")
            return await _refuse(websocket, "bad_ticket", "This call was already started, or it timed out. Start it again.")
        if claimed.get("session_id") != session_id:
            return await _refuse(websocket, "bad_ticket", "Something went wrong. Start the call again.")

        call = DemoCall(
            session_id,
            claimed["plan"],
            Limits(claimed["max_seconds"], claimed["wrap_up_seconds"], claimed["silence_seconds"]),
            voice_config(settings),
        )
        state["active"] += 1
        logger.info(f"[demo] call {session_id} starting ({state['active']} active)")
        try:
            await runner(call, websocket)
        except Exception:
            logger.exception(f"[demo] call {session_id} crashed")
            call.failed = True
            call.end_reason = "error"
        finally:
            state["active"] -= 1
            await worker.post_results(call.results())

    return app


async def _refuse(websocket: WebSocket, error: str, message: str) -> None:
    """Tell the browser why, then close with a policy-violation code."""
    await websocket.send_text(json.dumps({"type": "error", "error": error, "message": message}))
    await websocket.close(code=1008)


def _default_app() -> Any:
    """Build the app from the environment (used by ``python -m app.demo`` and uvicorn)."""
    return create_app(DemoSettings())


app = _default_app()
