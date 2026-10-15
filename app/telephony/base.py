"""The telephony provider interface.

A *telephony provider* is everything needed to run a real phone call leg over a
PSTN carrier: dialing out, answering the carrier's webhook with instructions to
open a media stream, and turning that media stream into a Pipecat transport.

Routes depend only on this interface (resolved via ``app.telephony.get_provider``),
so swapping Plivo → Twilio/Telnyx/Exotel is a new module, not a route change.

The call lifecycle a provider participates in:

    1. ``place_call``       — we POST to the carrier's REST API to dial ``to``.
                              The carrier will later fetch our ``answer_url``.
    2. ``answer_document``  — our answer webhook returns this; it tells the
                              carrier to open a bidirectional media-stream
                              WebSocket back to ``ws_url``.
    3. ``parse_stream_start`` — the carrier's first WebSocket message identifies
                              the stream; we extract the ids we need.
    4. ``build_transport``  — wrap that WebSocket in a Pipecat transport (with
                              the carrier's audio serializer) so the pipeline can
                              read/write audio and hang up cleanly.

Browser WebRTC test calls do *not* go through here — see ``app.transport``.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass
from typing import Any

from app.config import ResolvedCreds


@dataclass(frozen=True)
class StreamStart:
    """Identifiers parsed from a carrier's first media-stream message.

    These get handed to the carrier's frame serializer so it can address the
    right call (e.g. to hang up over REST when the agent ends the call).
    """

    stream_id: str
    call_id: str


class TelephonyProvider(abc.ABC):
    """Abstract base for a PSTN carrier integration."""

    #: Registry key / ``VOICE_TELEPHONY_PROVIDER`` value, e.g. ``"plivo"``.
    name: str

    @abc.abstractmethod
    async def place_call(
        self,
        *,
        to: str,
        from_number: str | None,
        answer_url: str,
        creds: "ResolvedCreds",
        status_url: str | None = None,
    ) -> str:
        """Dial ``to`` and point the carrier at ``answer_url`` when answered.

        ``creds`` carries the tenant's decrypted carrier credentials. If
        ``from_number`` is None, the provider falls back to ``creds`` /
        connection settings. ``status_url`` (if given) receives the carrier's
        hangup callback (cause/code) for audit. Returns the carrier's call id.
        """

    @abc.abstractmethod
    def answer_document(self, ws_url: str) -> tuple[str, str]:
        """Return ``(body, media_type)`` for the answer webhook response.

        The body instructs the carrier to open a bidirectional media-stream
        WebSocket to ``ws_url`` (e.g. PlivoXML ``<Stream>`` / Twilio TwiML).
        """

    @abc.abstractmethod
    def parse_stream_start(self, message: dict[str, Any]) -> StreamStart | None:
        """Parse the first WebSocket JSON message into a :class:`StreamStart`.

        Return ``None`` if the message is not the expected "start" event so the
        WS handler can reject the connection.
        """

    @abc.abstractmethod
    def build_transport(
        self, websocket: Any, start: StreamStart, *, creds: "ResolvedCreds"
    ) -> Any:
        """Wrap ``websocket`` in a Pipecat transport. ``creds`` lets the carrier
        serializer hang up the PSTN leg over REST when the call ends."""

    def verify_webhook(self, *, method: str, url: str, params: dict, headers: dict, creds: "ResolvedCreds") -> bool:
        """Verify a carrier webhook signature. Default: not implemented (return True).

        The single-use ``session_token`` is the primary carrier auth; signature
        verification is defense-in-depth where the carrier supports it.
        """
        return True
