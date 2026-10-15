"""Twilio telephony provider.

Implements :class:`~app.telephony.base.TelephonyProvider` over Twilio Programmable
Voice + Media Streams. Audio is mu-law 8kHz over a bidirectional WebSocket opened
by Twilio's ``<Connect><Stream>`` TwiML verb.

Credentials arrive per-call as ``ResolvedCreds.secrets`` (from the tenant's
encrypted connection):
    account_sid, auth_token   — REST auth + serializer hang-up
    from_number               — default caller id (overridable per call)
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


@telephony_registry.register("twilio")
class TwilioProvider(TelephonyProvider):
    name = "twilio"

    async def place_call(
        self,
        *,
        to: str,
        from_number: str | None,
        answer_url: str,
        creds: ResolvedCreds,
        status_url: str | None = None,
    ) -> str:
        account_sid = creds.secret("account_sid")
        auth_token = creds.secret("auth_token")
        from_number = from_number or creds.secrets.get("from_number")
        if not from_number:
            raise RuntimeError("Twilio connection has no from_number and none was supplied")

        # Twilio's REST API is form-encoded.
        data = {"From": from_number, "To": to, "Url": answer_url, "Method": "POST"}
        if status_url:
            data["StatusCallback"] = status_url
            data["StatusCallbackMethod"] = "POST"

        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"https://api.twilio.com/2010-04-01/Accounts/{account_sid}/Calls.json",
                auth=(account_sid, auth_token),
                data=data,
            )
        if resp.status_code >= 400:
            raise RuntimeError(f"Twilio API error: {resp.text}")
        return resp.json().get("sid", "")

    def answer_document(self, ws_url: str) -> tuple[str, str]:
        # Twilio drops query params on the <Stream> WebSocket URL, so the
        # session token is passed as a <Parameter> (arrives in the start event's
        # customParameters) instead of relying on ws_url's query string.
        from urllib.parse import parse_qs, urlparse

        token = parse_qs(urlparse(ws_url).query).get("session_token", [""])[0]
        body = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            "<Response>\n"
            "  <Connect>\n"
            f'    <Stream url="{ws_url}">\n'
            f'      <Parameter name="session_token" value="{token}" />\n'
            "    </Stream>\n"
            "  </Connect>\n"
            "</Response>"
        )
        return body, "application/xml"

    def parse_stream_start(self, message: dict[str, Any]) -> StreamStart | None:
        # Twilio sends a "connected" event first, then "start".
        if message.get("event") != "start":
            return None
        start = message.get("start", {})
        return StreamStart(
            stream_id=start.get("streamSid") or message.get("streamSid", ""),
            call_id=start.get("callSid", ""),
        )

    def build_transport(
        self, websocket: Any, start: StreamStart, *, creds: ResolvedCreds
    ) -> Any:
        from pipecat.audio.vad.silero import SileroVADAnalyzer
        from pipecat.serializers.twilio import TwilioFrameSerializer
        from pipecat.transports.websocket.fastapi import (
            FastAPIWebsocketParams,
            FastAPIWebsocketTransport,
        )

        serializer = TwilioFrameSerializer(
            stream_sid=start.stream_id,
            call_sid=start.call_id,
            account_sid=creds.secret("account_sid"),
            auth_token=creds.secret("auth_token"),
        )
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
        """Verify Twilio's X-Twilio-Signature (HMAC-SHA1). Defense-in-depth.

        Returns True if no signature header is present (the single-use
        session_token remains the primary guard).
        """
        signature = headers.get("x-twilio-signature") or headers.get("X-Twilio-Signature")
        if not signature:
            return True
        auth_token = creds.secret("auth_token")
        # Twilio: URL + each POST param key+value concatenated in alphabetical order.
        base_string = url + "".join(f"{k}{params[k]}" for k in sorted(params))
        expected = base64.b64encode(
            hmac.new(auth_token.encode(), base_string.encode(), hashlib.sha1).digest()
        ).decode()
        if not hmac.compare_digest(expected, signature):
            logger.warning("[twilio] webhook signature mismatch")
            return False
        return True
