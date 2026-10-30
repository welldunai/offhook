"""run_guarded: a call that never finishes stops counting as running."""

import asyncio
import types

import pytest

import app.browser.socket as browser_socket
from app.activity import active_calls


class FakeSocket:
    """Stands in for the accepted WebSocket; closing it hangs, as a broken proxy's can."""

    async def close(self) -> None:
        """Never returns."""
        await asyncio.Event().wait()


@pytest.mark.asyncio
async def test_a_pipeline_that_ignores_cancellation_stops_counting(monkeypatch):
    monkeypatch.setattr(browser_socket, "WATCHDOG_GRACE", -0.8)  # give up 0.2 s in
    call = types.SimpleNamespace(session_id="s", end_reason=None, failed=False,
                                 limits=types.SimpleNamespace(max_seconds=1))
    release = asyncio.Event()

    async def deaf(_call, _socket):
        # A pipeline that swallows cancellation and keeps going.
        while not release.is_set():
            try:
                await release.wait()
            except asyncio.CancelledError:
                continue

    guarded = asyncio.create_task(browser_socket.run_guarded(call, FakeSocket(), deaf))
    try:
        await asyncio.sleep(0.1)
        assert active_calls() == 1
        await asyncio.sleep(0.3)
        assert active_calls() == 0
        assert call.end_reason == "error"
    finally:
        guarded.cancel()
        release.set()
