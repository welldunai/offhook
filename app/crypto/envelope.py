"""Secret encryption using a per-tenant DEK (wrapped by the master key).

``get_or_create_tenant_dek`` returns a tenant's plaintext DEK (unwrapping the
stored wrapped key, or minting one on first use). ``encrypt_secret`` /
``decrypt_secret`` AES-GCM the secret JSON blob, binding it to its row via AAD
(``tenant_id|connection_id|provider_name``) so ciphertext can't be replayed
into a different connection.

Decrypted secrets and DEKs are kept only transiently in memory and never
logged, returned over the API, or written back in plaintext.
"""

from __future__ import annotations

import json
import os
import uuid

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy.ext.asyncio import AsyncSession

from app.crypto.keyprovider import KeyProvider, get_key_provider
from app.db.models import TenantKey


def _aad(tenant_id: uuid.UUID, connection_id: uuid.UUID, provider_name: str) -> bytes:
    return f"{tenant_id}|{connection_id}|{provider_name}".encode()


async def get_or_create_tenant_dek(
    db: AsyncSession,
    tenant_id: uuid.UUID,
    *,
    key_provider: KeyProvider | None = None,
) -> bytes:
    """Return the tenant's plaintext DEK, creating + persisting one if absent."""
    kp = key_provider or get_key_provider()
    row = await db.get(TenantKey, tenant_id)
    if row is not None:
        return kp.unwrap_dek(row.wrapped_dek, row.master_key_id)

    dek = os.urandom(32)
    wrapped, master_key_id = kp.wrap_dek(dek)
    db.add(TenantKey(tenant_id=tenant_id, wrapped_dek=wrapped, master_key_id=master_key_id))
    await db.flush()
    return dek


def encrypt_secret(
    dek: bytes,
    secrets: dict,
    *,
    tenant_id: uuid.UUID,
    connection_id: uuid.UUID,
    provider_name: str,
) -> tuple[bytes, bytes]:
    """Encrypt the secret dict. Returns (ciphertext, nonce)."""
    nonce = os.urandom(12)
    plaintext = json.dumps(secrets, separators=(",", ":")).encode()
    ciphertext = AESGCM(dek).encrypt(
        nonce, plaintext, _aad(tenant_id, connection_id, provider_name)
    )
    return ciphertext, nonce


def decrypt_secret(
    dek: bytes,
    ciphertext: bytes,
    nonce: bytes,
    *,
    tenant_id: uuid.UUID,
    connection_id: uuid.UUID,
    provider_name: str,
) -> dict:
    """Decrypt a connection's secret blob back into a dict."""
    plaintext = AESGCM(dek).decrypt(
        nonce, ciphertext, _aad(tenant_id, connection_id, provider_name)
    )
    return json.loads(plaintext)
