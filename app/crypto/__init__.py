"""Envelope encryption for tenant secrets.

Two layers:
  * A master key (KEK) — held outside the database (env today, KMS later via the
    pluggable KeyProvider). Wraps each tenant's data-encryption key.
  * A per-tenant DEK — random 32 bytes, stored wrapped in ``tenant_keys``.
    Encrypts that tenant's connection secrets (AES-GCM).

The database only ever holds ciphertext + wrapped DEKs; losing the master key
makes backups useless (and the secrets unrecoverable), which is the point.
"""

from app.crypto.envelope import (
    decrypt_secret,
    encrypt_secret,
    get_or_create_tenant_dek,
)
from app.crypto.keyprovider import EnvKeyProvider, KeyProvider, get_key_provider

__all__ = [
    "KeyProvider",
    "EnvKeyProvider",
    "get_key_provider",
    "encrypt_secret",
    "decrypt_secret",
    "get_or_create_tenant_dek",
]
