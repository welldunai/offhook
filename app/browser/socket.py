"""Running a browser call over a FastAPI WebSocket, with a watchdog.

Shared by the demo voice server and the dashboard's test calls.
"""

from __future__ import annotations

import asyncio
from typing import Awaitable, Callable

from fastapi import WebSocket
from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams, FastAPIWebsocketTransport

from app.activity import call_running
from app.browser.call import BrowserCall
from app.browser.serializer import SAMPLE_RATE, BrowserCallSerializer
from app.logger import logger

#: Seconds past a call's time limit before giving up on it, whatever the pipeline
#: is doing, so a stuck call can't hold its line (or the caller's slot) forever.
WATCHDOG_GRACE = 45

#: Runs a call over a socket; tests replace it.
CallRunner = Callable[[BrowserCall, WebSocket], Awaitable[None]]


async def run_over_socket(call: BrowserCall, websocket: WebSocket) -> None:
    """Run ``call`` with Pipecat's FastAPI WebSocket transport and the browser wire format.

    Args:
        call: The call to run.
        websocket: The accepted browser socket.
    """
    transport = FastAPIWebsocketTransport(
        websocket,
        FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_in_sample_rate=SAMPLE_RATE,
            audio_out_sample_rate=SAMPLE_RATE,
            serializer=BrowserCallSerializer(),
        ),
    )
    await call.run(transport)


async def run_guarded(call: BrowserCall, websocket: WebSocket, runner: CallRunner = run_over_socket) -> None:
    """Run a call, giving up on it if it outlives its limit by ``WATCHDOG_GRACE``.

    Never raises: a crash or a stuck pipeline is recorded on the call
    (``failed`` / ``end_reason``), so the caller can always report results.

    Args:
        call: The call to run.
        websocket: The accepted browser socket.
        runner: What runs the call; defaults to ``run_over_socket``.
    """
    running = asyncio.create_task(runner(call, websocket))
    # Counted here, not around the pipeline: a pipeline that never finishes would
    # otherwise count as a running call forever and keep the container awake.
    with call_running():
        done, _ = await asyncio.wait({running}, timeout=call.limits.max_seconds + WATCHDOG_GRACE)
    if not done:
        logger.error(f"[browser] call {call.session_id} didn't finish; giving up on it")
        running.cancel()
        call.end_reason = call.end_reason or "error"
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001 - already closed
            pass
    elif running.exception() is not None:
        logger.opt(exception=running.exception()).error(f"[browser] call {call.session_id} crashed")
        call.failed = True
        call.end_reason = "error"
