"""Env master-key provider: DEK wrap/unwrap, rotation, and unknown-key errors."""
import base64
import os

import pytest

from app.crypto.keyprovider import EnvKeyProvider


def test_wrap_unwrap_roundtrip():
    kp = EnvKeyProvider()
    dek = os.urandom(32)
    wrapped, kid = kp.wrap_dek(dek)
    assert kid == "v1"
    assert wrapped != dek
    assert kp.unwrap_dek(wrapped, kid) == dek


def test_self_test_passes():
    EnvKeyProvider().self_test()  # raises on failure


def test_unwrap_unknown_key_id_raises():
    kp = EnvKeyProvider()
    wrapped, _ = kp.wrap_dek(os.urandom(32))
    with pytest.raises(RuntimeError, match="not available"):
        kp.unwrap_dek(wrapped, "does-not-exist")


def test_rotation_keeps_old_key_available(monkeypatch):
    """A retired key set as MASTER_ENCRYPTION_KEY_<id> can still unwrap."""
    old_key = base64.b64encode(b"retired-key-aaaaaaaaaaaaaaaaaaaaa"[:32]).decode()
    monkeypatch.setenv("MASTER_ENCRYPTION_KEY_old", old_key)
    kp = EnvKeyProvider()
    # Simulate a DEK wrapped under the old key by encrypting with that provider id.
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    dek = os.urandom(32)
    raw = base64.b64decode(old_key)
    nonce = os.urandom(12)
    wrapped = nonce + AESGCM(raw).encrypt(nonce, dek, b"dek-wrap")
    assert kp.unwrap_dek(wrapped, "old") == dek
