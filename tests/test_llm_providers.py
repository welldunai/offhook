"""Groq defaults: gpt-oss-20b, at low reasoning effort unless the agent says otherwise."""

import pytest

from app.config import ResolvedCreds
from app.providers.llm import _build_groq


@pytest.mark.parametrize(
    "settings, model, extra",
    [
        ({}, "openai/gpt-oss-20b", {"reasoning_effort": "low"}),
        ({"model": "openai/gpt-oss-120b"}, "openai/gpt-oss-120b", {"reasoning_effort": "low"}),
        ({"reasoning_effort": "medium"}, "openai/gpt-oss-20b", {"reasoning_effort": "medium"}),
        ({"model": "qwen/qwen3.8-27b"}, "qwen/qwen3.8-27b", {}),
    ],
)
def test_groq_defaults(settings, model, extra):
    llm = _build_groq(ResolvedCreds("groq", {"api_key": "k"}, settings))
    assert llm.model_name == model
    assert llm._settings["extra"] == extra
