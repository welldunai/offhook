"""Client for the demo Worker's ``/internal/*`` routes.

Every request is signed (see ``app.demo.signing``). The Worker is the source of
truth for sessions: this server only learns a call's plan by claiming its
ticket, and reports back when the call ends.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx

from app.demo.signing import sign_request
from app.logger import logger


class ClaimRefused(Exception):
    """The Worker would not hand over the session (bad, used or expired ticket)."""

    def __init__(self, status: int, error: str) -> None:
        super().__init__(f"claim refused: {status} {error}")
        self.status = status
        self.error = error


class WorkerClient:
    """Signed calls to the Worker."""

    def __init__(self, base_url: str, secret: str, *, transport: httpx.AsyncBaseTransport | None = None) -> None:
        """
        Args:
            base_url: The Worker's URL, e.g. https://demo.offhook.welldun.ai.
            secret: DEMO_HMAC_SECRET.
            transport: Tests pass an ``httpx.MockTransport``.
        """
        self._base = base_url.rstrip("/")
        self._secret = secret
        self._transport = transport

    async def claim(self, ticket: str) -> dict[str, Any]:
        """Exchange a ticket for its session's plan. Works once per ticket.

        Args:
            ticket: From the browser.

        Returns:
            ``{session_id, plan, max_seconds, wrap_up_seconds, silence_seconds}``.

        Raises:
            ClaimRefused: The Worker said no (4xx), or couldn't be reached.
        """
        try:
            res = await self._post("/internal/claim", {"ticket": ticket})
        except httpx.HTTPError as e:
            raise ClaimRefused(0, f"worker unreachable: {e.__class__.__name__}") from e
        if res.status_code != 200:
            raise ClaimRefused(res.status_code, _error_of(res))
        return res.json()

    async def post_results(self, results: dict[str, Any], *, attempts: int = 4) -> bool:
        """Report a finished call, retrying network errors and 5xx with backoff.

        Args:
            results: The body for ``/internal/results`` (see ``DemoCall.results``).
            attempts: Total tries.

        Returns:
            True if the Worker accepted the results (or already had them).
        """
        for attempt in range(attempts):
            try:
                res = await self._post("/internal/results", results)
                if res.status_code in (200, 409):
                    return True
                if res.status_code < 500:
                    logger.error(f"[demo] results rejected: {res.status_code} {_error_of(res)}")
                    return False
            except httpx.HTTPError as e:
                logger.warning(f"[demo] results post failed: {e.__class__.__name__}")
            if attempt < attempts - 1:
                await asyncio.sleep(2**attempt)
        return False

    async def stats(self, days: int) -> dict[str, Any]:
        """Fetch the demo's daily counts (``POST /internal/stats``).

        Args:
            days: How many UTC days back, including today (1 to 365).

        Returns:
            ``{"days": [...], "use_cases": {...}}`` as the Worker sends it.

        Raises:
            httpx.HTTPError: if the Worker can't be reached or refuses.
        """
        res = await self._post("/internal/stats", {"days": days})
        res.raise_for_status()
        return res.json()

    async def _post(self, path: str, body: dict[str, Any]) -> httpx.Response:
        """POST ``body`` as signed JSON; the signature covers the exact bytes sent."""
        text = json.dumps(body, separators=(",", ":"))
        headers = {"content-type": "application/json", **sign_request(self._secret, text)}
        async with httpx.AsyncClient(timeout=5.0, transport=self._transport) as client:
            return await client.post(self._base + path, content=text.encode(), headers=headers)


def _error_of(res: httpx.Response) -> str:
    """Return the Worker's ``error`` code from a response, or the status text."""
    try:
        return str(res.json().get("error", res.reason_phrase))
    except ValueError:
        return res.reason_phrase
