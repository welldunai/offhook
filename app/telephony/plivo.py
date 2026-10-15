"""Plivo telephony provider.

Implements :class:`~app.telephony.base.TelephonyProvider` over Plivo Media
Streams. Audio is mu-law 8kHz delivered over a WebSocket Plivo opens against us
via the ``<Stream>`` PlivoXML verb.

Credentials arrive per-call as ``ResolvedCreds.secrets`` (from the tenant's
encrypted connection), not from process env:
    auth_id, auth_token   — REST auth + serializer hang-up
    from_number           — default caller id (overridable per call)
"""

from __future__ import annotations

import base64
import hashlib
import hmac
from typing import Any

import httpx

from app.config import ResolvedCreds
from app.logger import logger
from app.telephony import telephony_registry
from app.telephony.base import StreamStart, TelephonyProvider


@telephony_registry.register("plivo")
class PlivoProvider(TelephonyProvider):
    name = "plivo"

    async def place_call(
        self,
        *,
        to: str,
        from_number: str | None,
        answer_url: str,
        creds: ResolvedCreds,
        status_url: str | None = None,
    ) -> str:
        auth_id = creds.secret("auth_id")
        auth_token = creds.secret("auth_token")
        from_number = from_number or creds.secrets.get("from_number")
        if not from_number:
            raise RuntimeError("Plivo connection has no from_number and none was supplied")

        body = {
            "from": from_number,
            "to": to,
            "answer_url": answer_url,
            "answer_method": "POST",
        }
        if status_url:
            # Carrier hangup callback (cause/code) for audit + no-answer/busy detection.
            body["hangup_url"] = status_url
            body["hangup_method"] = "POST"

        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"https://api.plivo.com/v1/Account/{auth_id}/Call/",
                auth=(auth_id, auth_token),
                json=body,
            )
        if resp.status_code >= 400:
            raise RuntimeError(f"Plivo API error: {resp.text}")
        return resp.json().get("request_uuid", "")

    def answer_document(self, ws_url: str) -> tuple[str, str]:
        body = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            "<Response>\n"
            f'    <Stream bidirectional="true" keepCallAlive="true" '
            f'contentType="audio/x-mulaw;rate=8000">{ws_url}</Stream>\n'
            "</Response>"
        )
        return body, "application/xml"

    def parse_stream_start(self, message: dict[str, Any]) -> StreamStart | None:
        if message.get("event") != "start":
            logger.warning(f"[plivo] expected 'start', got {message.get('event')!r}")
            return None
        start = message.get("start", {})
        return StreamStart(
            stream_id=start.get("streamId") or message.get("streamId", ""),
            call_id=start.get("callId") or message.get("callId", ""),
        )

    def build_transport(
        self, websocket: Any, start: StreamStart, *, creds: ResolvedCreds
    ) -> Any:
        from pipecat.audio.vad.silero import SileroVADAnalyzer
        from pipecat.serializers.plivo import PlivoFrameSerializer
        from pipecat.transports.websocket.fastapi import (
            FastAPIWebsocketParams,
            FastAPIWebsocketTransport,
        )

        serializer = PlivoFrameSerializer(
            stream_id=start.stream_id,
            call_id=start.call_id,
            auth_id=creds.secret("auth_id"),
            auth_token=creds.secret("auth_token"),
        )

        # VAD on the transport: Plivo delivers raw mu-law continuously, so turn
        # detection in the user aggregator needs VAD on input.
        return FastAPIWebsocketTransport(
            websocket=websocket,
            params=FastAPIWebsocketParams(
                audio_in_enabled=True,
                audio_out_enabled=True,
                add_wav_header=False,
                vad_analyzer=SileroVADAnalyzer(),
                serializer=serializer,
            ),
        )

    def verify_webhook(
        self, *, method: str, url: str, params: dict, headers: dict, creds: ResolvedCreds
    ) -> bool:
        """Verify Plivo's X-Plivo-Signature-V3 (HMAC-SHA256). Defense-in-depth.

        Returns True if no signature header is present (so the single-use
        session_token remains the primary guard and we don't hard-fail on
        carriers that omit it). When a signature IS present, it must match.
        """
        signature = headers.get("x-plivo-signature-v3") or headers.get("X-Plivo-Signature-V3")
        nonce = headers.get("x-plivo-signature-v3-nonce") or headers.get("X-Plivo-Signature-V3-Nonce")
        if not signature or not nonce:
            return True  # nothing to verify

        auth_token = creds.secret("auth_token")
        base_string = url + nonce
        if method.upper() == "POST" and params:
            base_string += "".join(f"{k}{params[k]}" for k in sorted(params))
        expected = base64.b64encode(
            hmac.new(auth_token.encode(), base_string.encode(), hashlib.sha256).digest()
        ).decode()
        # Plivo may send multiple comma-separated signatures (multi-URL configs).
        return any(hmac.compare_digest(expected, s.strip()) for s in signature.split(","))
