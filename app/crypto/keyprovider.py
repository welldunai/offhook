"""Master-key (KEK) providers — pluggable so KMS can replace env later.

A KeyProvider wraps/unwraps per-tenant DEKs. The default ``EnvKeyProvider``
holds master keys in the environment, addressed by ``master_key_id`` so old
keys remain available for unwrap during rotation (add a new key, re-wrap DEKs,
retire the old). A future ``KmsKeyProvider`` implements the same two methods
against AWS/GCP KMS with no change to any call site.
"""

from __future__ import annotations

import base64
import os
from functools import lru_cache
from typing import Protocol

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.settings import settings


class KeyProvider(Protocol):
    def wrap_dek(self, dek: bytes) -> tuple[bytes, str]:
        """Encrypt a DEK with the active master key. Returns (wrapped, master_key_id)."""
        ...

    def unwrap_dek(self, wrapped: bytes, master_key_id: str) -> bytes:
        """Decrypt a DEK using the master key identified by ``master_key_id``."""
        ...


def _load_master_keys() -> dict[str, bytes]:
    """Collect master keys by id.

    The active key is ``MASTER_ENCRYPTION_KEY`` (id = ``MASTER_KEY_ID``, default
    'v1'). Additional retired keys for rotation: ``MASTER_ENCRYPTION_KEY_<id>``.
    """
    keys: dict[str, bytes] = {}
    if settings.master_encryption_key:
        keys[settings.master_key_id] = base64.b64decode(settings.master_encryption_key)
    prefix = "MASTER_ENCRYPTION_KEY_"
    for env_name, value in os.environ.items():
        if env_name.startswith(prefix) and value:
            key_id = env_name[len(prefix):].lower()
            try:
                raw = base64.b64decode(value, validate=True)
            except Exception:  # noqa: BLE001
                continue
            if len(raw) == 32:
                keys[key_id] = raw
    return keys


class EnvKeyProvider:
    """Master keys held in the environment. AES-GCM key wrapping."""

    def __init__(self) -> None:
        self._keys = _load_master_keys()
        self._active_id = settings.master_key_id

    def _require_active(self) -> bytes:
        key = self._keys.get(self._active_id)
        if key is None:
            raise RuntimeError(
                "No active master encryption key. Set MASTER_ENCRYPTION_KEY "
                "(base64 of 32 bytes) and MASTER_KEY_ID."
            )
        return key

    def wrap_dek(self, dek: bytes) -> tuple[bytes, str]:
        master = self._require_active()
        nonce = os.urandom(12)
        # Prepend the nonce so unwrap is self-contained.
        wrapped = nonce + AESGCM(master).encrypt(nonce, dek, b"dek-wrap")
        return wrapped, self._active_id

    def unwrap_dek(self, wrapped: bytes, master_key_id: str) -> bytes:
        master = self._keys.get(master_key_id)
        if master is None:
            raise RuntimeError(f"Master key {master_key_id!r} not available for unwrap")
        nonce, ct = wrapped[:12], wrapped[12:]
        return AESGCM(master).decrypt(nonce, ct, b"dek-wrap")

    def self_test(self) -> None:
        """Wrap+unwrap a random DEK to prove the active key works (readiness check)."""
        probe = os.urandom(32)
        wrapped, kid = self.wrap_dek(probe)
        if self.unwrap_dek(wrapped, kid) != probe:
            raise RuntimeError("Master key self-test failed")


class KmsKeyProvider:
    """Wrap/unwrap tenant DEKs with AWS KMS. The master key never leaves KMS.

    Selected via ``KEY_PROVIDER=kms`` + ``KMS_KEY_ID``. boto3 is imported lazily
    so it's only required when KMS is actually used. ``master_key_id`` records
    the KMS key id used, so rotation (new key id) keeps old wraps decryptable.
    """

    def __init__(self) -> None:
        self._key_id = settings.kms_key_id
        if not self._key_id:
            raise RuntimeError("KMS_KEY_ID is required when KEY_PROVIDER=kms")

    def _client(self):  # lazy
        import boto3  # type: ignore

        return boto3.client("kms")

    def wrap_dek(self, dek: bytes) -> tuple[bytes, str]:
        resp = self._client().encrypt(KeyId=self._key_id, Plaintext=dek)
        return resp["CiphertextBlob"], self._key_id

    def unwrap_dek(self, wrapped: bytes, master_key_id: str) -> bytes:
        # KMS finds the key from the ciphertext; KeyId is advisory.
        resp = self._client().decrypt(CiphertextBlob=wrapped, KeyId=master_key_id or self._key_id)
        return resp["Plaintext"]

    def self_test(self) -> None:
        probe = os.urandom(32)
        wrapped, kid = self.wrap_dek(probe)
        if self.unwrap_dek(wrapped, kid) != probe:
            raise RuntimeError("KMS key self-test failed")


@lru_cache
def get_key_provider() -> KeyProvider:
    if settings.key_provider == "kms":
        return KmsKeyProvider()
    return EnvKeyProvider()
