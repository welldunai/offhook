"""Settings validation — especially the prod fail-fast guards."""
import base64

import pytest
from pydantic import ValidationError

from app.settings import Settings

VALID_KEY = base64.b64encode(b"x" * 32).decode()


def _prod_env(monkeypatch, **overrides):
    """Set a minimally-valid prod env, then apply overrides (None = unset)."""
    base = {
        "ENV": "prod", "MASTER_ENCRYPTION_KEY": VALID_KEY,
        "PUBLIC_BASE_URL": "https://api.example.com",
        "ENABLE_PREBUILT_UI": "0", "WEBHOOK_ALLOW_PRIVATE": "0",
    }
    base.update(overrides)
    for k, v in base.items():
        if v is None:
            monkeypatch.delenv(k, raising=False)
        else:
            monkeypatch.setenv(k, v)


def _settings() -> Settings:
    # _env_file=None isolates the test from the repo's .env file.
    return Settings(_env_file=None)


def test_prod_valid(monkeypatch):
    _prod_env(monkeypatch)
    s = _settings()
    assert s.is_prod and s.public_base_url == "https://api.example.com"


def test_prod_requires_master_key(monkeypatch):
    _prod_env(monkeypatch, MASTER_ENCRYPTION_KEY=None)
    with pytest.raises(ValidationError, match="MASTER_ENCRYPTION_KEY is required"):
        _settings()


def test_prod_requires_public_base_url(monkeypatch):
    _prod_env(monkeypatch, PUBLIC_BASE_URL=None)
    with pytest.raises(ValidationError, match="PUBLIC_BASE_URL is required"):
        _settings()


def test_prod_rejects_prebuilt_ui(monkeypatch):
    _prod_env(monkeypatch, ENABLE_PREBUILT_UI="1")
    with pytest.raises(ValidationError, match="ENABLE_PREBUILT_UI must be false"):
        _settings()


def test_prod_rejects_webhook_allow_private(monkeypatch):
    _prod_env(monkeypatch, WEBHOOK_ALLOW_PRIVATE="1")
    with pytest.raises(ValidationError, match="WEBHOOK_ALLOW_PRIVATE must be false"):
        _settings()


def test_master_key_must_be_base64(monkeypatch):
    monkeypatch.setenv("ENV", "dev")
    monkeypatch.setenv("MASTER_ENCRYPTION_KEY", "!!! not base64 !!!")
    with pytest.raises(ValidationError, match="valid base64"):
        _settings()


def test_master_key_must_be_32_bytes(monkeypatch):
    monkeypatch.setenv("ENV", "dev")
    monkeypatch.setenv("MASTER_ENCRYPTION_KEY", base64.b64encode(b"too-short").decode())
    with pytest.raises(ValidationError, match="32 bytes"):
        _settings()


def test_cors_origins_parsed_to_list(monkeypatch):
    monkeypatch.setenv("ENV", "dev")
    monkeypatch.setenv("CORS_ORIGINS", "https://a.com, https://b.com ,")
    assert _settings().cors_origin_list == ["https://a.com", "https://b.com"]
