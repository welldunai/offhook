"""Log redaction scrubs secrets from rendered messages."""
from app.security.redaction import _scrub


def test_scrubs_bearer_token():
    out = _scrub("Authorization: Bearer abc.def-123_XYZ")
    assert "abc.def-123_XYZ" not in out
    assert "redacted" in out


def test_scrubs_vk_api_key():
    out = _scrub("using key vk_dev_deadbeef_SecretValue123 now")
    assert "SecretValue123" not in out
    assert "vk_" in out  # marker kept, secret gone


def test_scrubs_json_secret_fields():
    for field in ["api_key", "auth_token", "secret", "password", "access_token"]:
        msg = f'{{"{field}": "supersecret"}}'
        assert "supersecret" not in _scrub(msg)


def test_scrubs_kwarg_style():
    assert "hunter2" not in _scrub("password=hunter2")


def test_leaves_innocuous_text_untouched():
    msg = "call completed in 38 seconds for tenant acme"
    assert _scrub(msg) == msg
