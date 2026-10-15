"""ResolvedCreds accessors (the seam every provider factory reads)."""
import pytest

from app.config import ResolvedCreds


def test_secret_returns_value():
    rc = ResolvedCreds(provider_name="cartesia", secrets={"api_key": "k", "voice_id": "v"})
    assert rc.secret("api_key") == "k"
    assert rc.secret("voice_id") == "v"


def test_secret_missing_raises():
    rc = ResolvedCreds(provider_name="cartesia", secrets={"api_key": "k"})
    with pytest.raises(RuntimeError, match="missing secret 'voice_id'"):
        rc.secret("voice_id")


def test_setting_default():
    rc = ResolvedCreds(provider_name="cartesia", secrets={}, settings={"model": "sonic-3"})
    assert rc.setting("model") == "sonic-3"
    assert rc.setting("speed", 1.0) == 1.0


def test_setting_override_then_credential_fallback():
    # mirrors the cartesia factory: setting("voice_id") or secret("voice_id")
    rc = ResolvedCreds(provider_name="cartesia", secrets={"voice_id": "cred"}, settings={})
    assert (rc.setting("voice_id") or rc.secret("voice_id")) == "cred"
    rc2 = ResolvedCreds(provider_name="cartesia", secrets={"voice_id": "cred"}, settings={"voice_id": "override"})
    assert (rc2.setting("voice_id") or rc2.secret("voice_id")) == "override"
