"""The voice server's signing must match the Worker's byte for byte."""

from app.demo.signing import make_ticket, read_ticket, sign_request

SID = "3b2e6f1c-8a4d-4a8e-9f0b-1c2d3e4f5a6b"
# Pinned in demo/worker/test/sign.test.ts too.
TICKET = (
    "eyJzaWQiOiIzYjJlNmYxYy04YTRkLTRhOGUtOWYwYi0xYzJkM2U0ZjVhNmIiLCJleHAiOjE3OTIwMDAwMDB9"
    ".6efc2c59eac016165f4888e68b05f6c2d92752532014417a0ff327c47b631489"
)


def test_ticket_matches_worker():
    assert make_ticket("test-secret", SID, now=1_791_999_940) == TICKET
    assert read_ticket("test-secret", TICKET, now=1_791_999_999) == SID


def test_request_signature_matches_worker():
    assert sign_request("test-secret", '{"ticket":"abc"}', now=1_792_000_000) == {
        "x-offhook-timestamp": "1792000000",
        "x-offhook-signature": "2cf36802ad16235bf86a3968b350a84f5f3303a587f1c605d55fcfd22f3a26e8",
    }


def test_ticket_expires():
    t = make_ticket("k", SID, now=1000)
    assert read_ticket("k", t, now=1059) == SID
    assert read_ticket("k", t, now=1061) is None


def test_rejects_forged_and_malformed_tickets():
    t = make_ticket("k", SID, now=1000)
    payload, sig = t.split(".")
    assert read_ticket("other", t, now=1000) is None
    assert read_ticket("k", f"{payload}.{'0' * 64}", now=1000) is None
    assert read_ticket("k", f"{payload[:-2]}AA.{sig}", now=1000) is None
    for junk in (None, "", "a.b.c", payload, 42, "x" * 2000):
        assert read_ticket("k", junk, now=1000) is None
