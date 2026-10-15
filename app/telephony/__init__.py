"""Telephony backends (PSTN carriers).

A telephony provider handles the phone-call leg: dialing out, answering the
carrier webhook, and building a Pipecat transport from the media stream. Routes
resolve one by name via :func:`get_provider` and never import a concrete
carrier.

Adding a carrier:
    1. Create ``app/telephony/<carrier>.py`` with a subclass of
       :class:`~app.telephony.base.TelephonyProvider` decorated with
       ``@telephony_registry.register("<carrier>")``.
    2. Import it below so registration runs.
    3. Set ``VOICE_TELEPHONY_PROVIDER=<carrier>``.
"""

from app.registry import Registry
from app.telephony.base import StreamStart, TelephonyProvider

#: name → TelephonyProvider subclass. Populated by the modules imported below.
telephony_registry: Registry[type[TelephonyProvider]] = Registry("telephony")

# Import side-effect: registers each provider. Keep below the registry so the
# decorator has something to register into.
from app.telephony import plivo  # noqa: E402,F401
from app.telephony import twilio  # noqa: E402,F401

__all__ = ["telephony_registry", "get_provider", "TelephonyProvider", "StreamStart"]

# Providers are stateless, so one instance per name is fine.
_instances: dict[str, TelephonyProvider] = {}


def get_provider(name: str) -> TelephonyProvider:
    """Return the (cached) telephony provider instance registered under ``name``."""
    if name not in _instances:
        _instances[name] = telephony_registry.get(name)()
    return _instances[name]
