"""Envelope encryption: roundtrip, AAD row-binding, and tamper detection."""
import os
import uuid

import pytest
from cryptography.exceptions import InvalidTag

from app.crypto.envelope import decrypt_secret, encrypt_secret

TID = uuid.uuid4()
CID = uuid.uuid4()


def _enc(dek, secrets, *, tid=TID, cid=CID, provider="cartesia"):
    return encrypt_secret(dek, secrets, tenant_id=tid, connection_id=cid, provider_name=provider)


def test_roundtrip():
    dek = os.urandom(32)
    ct, nonce = _enc(dek, {"api_key": "sk_123", "voice_id": "v1"})
    out = decrypt_secret(dek, ct, nonce, tenant_id=TID, connection_id=CID, provider_name="cartesia")
    assert out == {"api_key": "sk_123", "voice_id": "v1"}


def test_nonce_is_random_per_encryption():
    dek = os.urandom(32)
    _, n1 = _enc(dek, {"a": "b"})
    _, n2 = _enc(dek, {"a": "b"})
    assert n1 != n2


def test_wrong_dek_fails():
    ct, nonce = _enc(os.urandom(32), {"api_key": "x"})
    with pytest.raises(InvalidTag):
        decrypt_secret(os.urandom(32), ct, nonce, tenant_id=TID, connection_id=CID, provider_name="cartesia")


@pytest.mark.parametrize("field", ["tenant", "connection", "provider"])
def test_aad_binding_rejects_replay_into_another_row(field):
    """Ciphertext can't be moved to a different tenant/connection/provider."""
    dek = os.urandom(32)
    ct, nonce = _enc(dek, {"api_key": "x"})
    kw = dict(tenant_id=TID, connection_id=CID, provider_name="cartesia")
    if field == "tenant":
        kw["tenant_id"] = uuid.uuid4()
    elif field == "connection":
        kw["connection_id"] = uuid.uuid4()
    else:
        kw["provider_name"] = "deepgram"
    with pytest.raises(InvalidTag):
        decrypt_secret(dek, ct, nonce, **kw)


def test_tampered_ciphertext_fails():
    dek = os.urandom(32)
    ct, nonce = _enc(dek, {"api_key": "x"})
    tampered = bytes([ct[0] ^ 0xFF]) + ct[1:]
    with pytest.raises(InvalidTag):
        decrypt_secret(dek, tampered, nonce, tenant_id=TID, connection_id=CID, provider_name="cartesia")
