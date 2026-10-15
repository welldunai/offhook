"""API key generation, parsing, and argon2 verification."""
from app.auth.apikey import generate_key, parse_key, verify_secret


def test_generate_key_shape():
    gen = generate_key()
    assert gen.full_key.startswith("vk_")
    assert gen.prefix and gen.prefix in gen.full_key
    assert gen.key_hash.startswith("$argon2")
    # the plaintext secret is never equal to its stored hash
    assert gen.key_hash not in gen.full_key


def test_keys_are_unique():
    a, b = generate_key(), generate_key()
    assert a.full_key != b.full_key and a.prefix != b.prefix


def test_parse_roundtrip_and_verify():
    gen = generate_key()
    parsed = parse_key(gen.full_key)
    assert parsed is not None
    prefix, secret = parsed
    assert prefix == gen.prefix
    assert verify_secret(gen.key_hash, secret) is True


def test_verify_rejects_wrong_secret():
    gen = generate_key()
    assert verify_secret(gen.key_hash, "not-the-secret") is False


def test_verify_handles_malformed_hash():
    assert verify_secret("not-a-real-argon2-hash", "whatever") is False


def test_secret_with_underscores_rejoined():
    # token_urlsafe can contain '_' — parse must rejoin the tail, not split it.
    parsed = parse_key("vk_dev_abc123_part_with_underscores")
    assert parsed == ("abc123", "part_with_underscores")


def test_parse_rejects_malformed():
    for bad in ["", "nope", "xx_dev_p_s", "vk_dev_", "vk_dev"]:
        assert parse_key(bad) is None
