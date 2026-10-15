"""Webhook HMAC signing (Stripe-style t=,v1=)."""
from app.webhooks.signing import generate_secret, sign_payload, verify_signature


def test_generate_secret_shape():
    s = generate_secret()
    assert s.startswith("whsec_") and len(s) > 20


def test_sign_verify_roundtrip():
    secret, body = generate_secret(), '{"event":"call.completed"}'
    header = sign_payload(secret, body, timestamp=1000)
    assert header.startswith("t=1000,v1=")
    assert verify_signature(secret, body, header) is True


def test_verify_rejects_tampered_body():
    secret = generate_secret()
    header = sign_payload(secret, '{"a":1}', timestamp=1000)
    assert verify_signature(secret, '{"a":2}', header) is False


def test_verify_rejects_wrong_secret():
    header = sign_payload(generate_secret(), "body", timestamp=1000)
    assert verify_signature(generate_secret(), "body", header) is False


def test_verify_rejects_stale_timestamp():
    secret, body = generate_secret(), "body"
    header = sign_payload(secret, body, timestamp=1000)
    assert verify_signature(secret, body, header, tolerance_seconds=300, now=2000) is False
    assert verify_signature(secret, body, header, tolerance_seconds=300, now=1100) is True


def test_verify_rejects_malformed_header():
    secret = generate_secret()
    for bad in ["", "garbage", "t=abc,v1=x", "v1=onlysig"]:
        assert verify_signature(secret, "body", bad) is False
