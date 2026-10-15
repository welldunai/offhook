"""Speech-to-text providers.

Each provider is a factory registered under a name in ``stt_registry``. It
receives a :class:`~app.config.ResolvedCreds` (the tenant's decrypted key +
non-secret settings) and returns a Pipecat STT service. Factories never read
process env — credentials always arrive as data.

To add a provider: install its pipecat extra, add a factory below decorated
with ``@stt_registry.register("<name>")``, and add the name to
``SUPPORTED_PROVIDERS["stt"]`` in ``app/config.py``.
"""

from typing import Any

from app.config import ResolvedCreds
from app.registry import Registry

#: name → factory(creds) -> Pipecat STT service.
stt_registry: Registry[Any] = Registry("STT")


@stt_registry.register("deepgram")
def _build_deepgram(creds: ResolvedCreds) -> Any:
    from pipecat.services.deepgram.stt import DeepgramSTTService

    return DeepgramSTTService(
        api_key=creds.secret("api_key"),
        model=creds.setting("model", "nova-3"),
    )
