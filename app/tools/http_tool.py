"""Tenant-defined HTTP tools — the LLM calls them mid-conversation to fetch data.

A tenant declares a tool (name, description, argument schema, an HTTP endpoint,
and optional static auth headers). When the model calls it during a call, the
platform issues the HTTP request with the model's arguments and feeds the
response back to the model, which keeps talking.

Everything in here runs on untrusted-ish input from two directions, so it is
defensive on purpose:

  * **Arguments come from the LLM.** They only ever fill declared ``{param}``
    placeholders in the path (URL-encoded) or become query/body values — they
    can never change the host, scheme, headers, or method.
  * **The URL is tenant-configured.** It is SSRF-validated both at write time
    (the API) and again here at call time, and the post-templating host must
    equal the configured host (no DNS-rebind / path-injection to internal IPs).
  * **The endpoint is external and may be slow or huge.** Requests are bounded
    by a per-tool timeout; responses are truncated to a fixed size so a runaway
    payload can't blow the LLM context.

A handler never raises into the pipeline: failures are returned to the model as
a structured ``{"error": ...}`` so the agent can apologize and move on instead
of the call crashing.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote, urlsplit

import httpx

from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.services.llm_service import FunctionCallParams

from app.logger import logger
from app.security.ssrf import UnsafeURLError, validate_public_url

#: Cap on the response text handed back to the model (characters). Keeps a
#: pathological payload from swamping the context window.
MAX_RESULT_CHARS = 8000
#: Hard ceiling on per-tool timeout regardless of what the tenant configured —
#: a tool that hangs would stall the live conversation.
MAX_TIMEOUT_SECONDS = 20.0


@dataclass
class ResolvedTool:
    """A custom tool with its auth headers already decrypted, ready to invoke."""

    name: str
    description: str
    parameters: dict  # {"properties": {...}, "required": [...]}
    method: str
    url: str
    headers: dict[str, str] = field(default_factory=dict)
    timeout_seconds: float = 10.0

    def to_function_schema(self) -> FunctionSchema:
        return FunctionSchema(
            name=self.name,
            description=self.description,
            properties=self.parameters.get("properties", {}) or {},
            required=self.parameters.get("required", []) or [],
        )


def _build_request(tool: ResolvedTool, args: dict[str, Any]) -> tuple[str, dict, Any]:
    """Map LLM arguments onto a concrete request.

    Returns ``(url, query_params, json_body)``. Path placeholders ``{name}`` are
    URL-encoded (so a value can't smuggle in a new path segment or host). The
    remaining declared arguments become the query string (GET) or JSON body
    (everything else).
    """
    declared = set((tool.parameters.get("properties") or {}).keys())
    url = tool.url
    consumed: set[str] = set()
    for key in declared:
        token = "{" + key + "}"
        if token in url:
            url = url.replace(token, quote(str(args.get(key, "")), safe=""))
            consumed.add(key)

    rest = {k: v for k, v in args.items() if k in declared and k not in consumed}
    if tool.method.upper() == "GET":
        return url, rest, None
    return url, {}, (rest or {})


def _safe_result(payload: Any) -> Any:
    """Truncate a response payload to a model-safe size."""
    if isinstance(payload, str):
        if len(payload) > MAX_RESULT_CHARS:
            return payload[:MAX_RESULT_CHARS] + "…[truncated]"
        return payload
    try:
        text = json.dumps(payload)
    except (TypeError, ValueError):
        return {"error": "tool returned non-serializable data"}
    if len(text) > MAX_RESULT_CHARS:
        return {"truncated": True, "data": text[:MAX_RESULT_CHARS] + "…[truncated]"}
    return payload


def make_http_handler(tool: ResolvedTool):
    """Build the async pipecat handler that invokes this tool's HTTP endpoint."""

    configured_host = (urlsplit(tool.url).hostname or "").lower()
    timeout = min(max(float(tool.timeout_seconds or 10.0), 1.0), MAX_TIMEOUT_SECONDS)

    async def handler(params: FunctionCallParams) -> None:
        args = params.arguments or {}

        # Required arguments must be present — otherwise let the model re-ask.
        missing = [k for k in (tool.parameters.get("required") or []) if k not in args]
        if missing:
            await params.result_callback(
                {"error": f"missing required argument(s): {', '.join(missing)}"}
            )
            return

        url, query, body = _build_request(tool, args)

        # Re-validate the resolved URL and pin the host: templating must not have
        # changed where we connect (no path-injection to an internal address).
        try:
            validate_public_url(url)
            if (urlsplit(url).hostname or "").lower() != configured_host:
                raise UnsafeURLError("tool URL host changed after templating")
        except UnsafeURLError as exc:
            logger.warning(f"[tool:{tool.name}] blocked unsafe URL: {exc}")
            await params.result_callback({"error": "tool endpoint is not allowed"})
            return

        try:
            async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
                resp = await client.request(
                    tool.method.upper(), url,
                    params=query or None, json=body, headers=tool.headers or None,
                )
        except httpx.TimeoutException:
            logger.warning(f"[tool:{tool.name}] timed out after {timeout}s")
            await params.result_callback({"error": "tool request timed out"})
            return
        except httpx.HTTPError as exc:
            logger.warning(f"[tool:{tool.name}] request error: {exc!r}")
            await params.result_callback({"error": "tool request failed"})
            return

        # Log host + status only — never the auth headers or response body.
        logger.info(f"[tool:{tool.name}] {tool.method.upper()} {configured_host} -> {resp.status_code}")

        if resp.status_code >= 400:
            await params.result_callback(
                {"error": f"endpoint returned HTTP {resp.status_code}",
                 "body": _safe_result(resp.text)}
            )
            return

        try:
            payload: Any = resp.json()
        except ValueError:
            payload = resp.text
        await params.result_callback({"ok": True, "result": _safe_result(payload)})

    return handler
