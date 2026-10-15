"""Browser WebRTC transport (dev / test calls).

This is the no-telephony path: a browser mic connects directly over a
SmallWebRTC peer connection, so you can talk to an agent without a phone
number or carrier account. Production phone calls go through a telephony
provider instead — see ``app.telephony``.

Unlike the telephony path, VAD is *not* placed on this transport; it lives on
the LLM user aggregator (see ``app.pipeline``) because WebRTC already delivers
discrete, browser-gated audio.
"""

from typing import Any

from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport


def build_webrtc_transport(webrtc_connection: Any) -> SmallWebRTCTransport:
    """Wrap a negotiated SmallWebRTC connection in a Pipecat transport."""
    return SmallWebRTCTransport(
        webrtc_connection=webrtc_connection,
        params=TransportParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
        ),
    )
