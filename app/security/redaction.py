"""Log redaction — keep secrets out of logs.

A loguru patcher that scrubs the rendered message of anything that looks like a
bearer token, API key, or our own session/connection secrets. Defense-in-depth:
the real rule is "don't log secrets in the first place", but this catches
mistakes (a dict with an ``api_key`` field, an ``Authorization`` header, etc.).
"""

from __future__ import annotations

import re

# Patterns scrubbed from every log line.
_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    # Authorization: Bearer xxx  /  bare bearer tokens
    (re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._\-]+"), r"\1«redacted»"),
    # our API keys: vk_<env>_<prefix>_<secret>
    (re.compile(r"vk_[a-z]+_[a-f0-9]+_[A-Za-z0-9_\-]+"), "vk_«redacted»"),
    # "api_key": "...", api_key=..., auth_token: ...  (json/kwargs styles)
    (
        re.compile(
            r"(?i)(\"?(?:api[_-]?key|auth[_-]?token|secret|password|access[_-]?token)\"?\s*[:=]\s*\"?)"
            r"[^\s\",}]+"
        ),
        r"\1«redacted»",
    ),
]


def _scrub(text: str) -> str:
    for pattern, repl in _PATTERNS:
        text = pattern.sub(repl, text)
    return text


def install_redaction(logger) -> None:
    """Patch a loguru logger so every record's message is scrubbed."""

    def _patcher(record: dict) -> None:
        try:
            record["message"] = _scrub(record["message"])
        except Exception:  # never let logging raise
            pass

    logger.configure(patcher=_patcher)
