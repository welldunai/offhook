"""Logging setup.

Pipecat logs through `loguru`, including its rich per-stage metrics observers
(TTFB, processing time, token/character usage, user→bot latency). We use the
same `loguru` logger for the app so everything shares one configurable sink,
and install a redaction patcher so secrets never reach the logs.

Level is controlled by ``LOG_LEVEL`` (default ``DEBUG`` — the verbose testing
view that surfaces pipecat's metrics). Set ``LOG_LEVEL=INFO`` to quiet it down,
or ``TRACE`` for pipecat's frame-by-frame firehose.
"""

import sys

from loguru import logger

from app.security.redaction import install_redaction
from app.settings import settings

logger.remove()
logger.add(
    sys.stderr,
    level=settings.log_level,
    format=(
        "<green>{time:HH:mm:ss.SSS}</green> "
        "<level>{level: <7}</level> "
        "<cyan>{name}</cyan> {message}"
    ),
)

# Scrub secrets/tokens from every record (defense-in-depth).
install_redaction(logger)

__all__ = ["logger"]
