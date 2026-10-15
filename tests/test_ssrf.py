"""SSRF guard for tenant-influenced URLs."""
import pytest

from app.security.ssrf import UnsafeURLError, validate_public_url

# IP literals avoid real DNS in tests (getaddrinfo resolves a literal to itself).
BLOCKED = [
    "http://127.0.0.1/x",            # loopback
    "http://10.0.0.5/x",             # private
    "http://192.168.1.1/x",          # private
    "http://169.254.169.254/latest", # cloud metadata
    "http://100.64.0.1/x",           # CGNAT
    "http://0.0.0.0/x",              # unspecified
]
ALLOWED = [
    "https://1.1.1.1/hook",
    "https://8.8.8.8/hook",
    "http://93.184.216.34/hook",     # http allowed in dev (allow_http defaults true)
]


@pytest.mark.parametrize("url", BLOCKED)
def test_blocks_internal_addresses(url):
    with pytest.raises(UnsafeURLError):
        validate_public_url(url, allow_http=True)


@pytest.mark.parametrize("url", ALLOWED)
def test_allows_public_addresses(url):
    assert validate_public_url(url, allow_http=True) == url


def test_rejects_unsupported_scheme():
    with pytest.raises(UnsafeURLError):
        validate_public_url("ftp://1.1.1.1/x")


def test_rejects_http_when_https_required():
    with pytest.raises(UnsafeURLError):
        validate_public_url("http://1.1.1.1/x", allow_http=False)


def test_rejects_embedded_credentials():
    with pytest.raises(UnsafeURLError):
        validate_public_url("https://user:pass@1.1.1.1/x", allow_http=True)


def test_allow_private_escape_hatch():
    # dev-only flag bypasses the private-address checks
    assert validate_public_url("http://127.0.0.1/x", allow_http=True, allow_private=True)
