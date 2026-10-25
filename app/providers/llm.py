"""LLM providers.

Each factory receives a :class:`~app.config.ResolvedCreds` and returns a
Pipecat LLM service. The system prompt is NOT set here — it lives on the
``LLMContext`` (see ``app/pipeline.py``). Per the locked design, ``base_url``
for each provider is a hardcoded constant (no arbitrary tenant-supplied
endpoints); only the API key + model name come from the connection.
"""

from typing import Any

from app.config import ResolvedCreds
from app.registry import Registry

#: name → factory(creds) -> Pipecat LLM service.
llm_registry: Registry[Any] = Registry("LLM")

# OpenAI-compatible endpoints. Tenants pick a provider + supply a key; they
# cannot point us at an arbitrary URL.
_BASE_URLS = {
    "openrouter": "https://openrouter.ai/api/v1",
    "groq": "https://api.groq.com/openai/v1",
    "gemini": "https://generativelanguage.googleapis.com/v1beta/openai/",
    "openai": None,  # default OpenAI base
}


def _openai_compatible(creds: ResolvedCreds, default_model: str, default_effort: str | None = None) -> Any:
    from pipecat.services.openai.llm import OpenAILLMService

    base_url = _BASE_URLS[creds.provider_name]
    kwargs: dict[str, Any] = {
        "api_key": creds.secret("api_key"),
        "model": creds.setting("model", default_model),
    }
    if base_url:
        kwargs["base_url"] = base_url
    # Reasoning models (e.g. gpt-oss on Groq) think before answering; on a live
    # call, "low" keeps replies quick.
    effort = creds.setting("reasoning_effort", default_effort)
    if effort:
        kwargs["params"] = OpenAILLMService.InputParams(extra={"reasoning_effort": effort})
    return OpenAILLMService(**kwargs)


@llm_registry.register("openrouter")
def _build_openrouter(creds: ResolvedCreds) -> Any:
    return _openai_compatible(creds, "google/gemini-2.5-flash")


@llm_registry.register("groq")
def _build_groq(creds: ResolvedCreds) -> Any:
    # Groq retired its Llama models. gpt-oss reasons before it answers; at the
    # default effort it is slower and sometimes emits malformed tool calls, so
    # calls run at "low" unless the agent sets reasoning_effort.
    model = creds.setting("model", "openai/gpt-oss-20b")
    effort = "low" if str(model).startswith("openai/gpt-oss") else None
    return _openai_compatible(creds, "openai/gpt-oss-20b", effort)


@llm_registry.register("gemini")
def _build_gemini(creds: ResolvedCreds) -> Any:
    return _openai_compatible(creds, "gemini-2.5-flash")


@llm_registry.register("openai")
def _build_openai(creds: ResolvedCreds) -> Any:
    return _openai_compatible(creds, "gpt-4o-mini")
