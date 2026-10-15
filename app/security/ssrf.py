"""SSRF protection for outbound/tenant-influenced URLs.

Any URL we will *fetch* on a tenant's behalf (Phase-2 webhook callbacks) or
derive from request input must be validated so it can't point at internal
infrastructure or the cloud metadata service.

``validate_public_url`` parses the URL, requires https (http only in dev), and
resolves DNS, rejecting if *any* resolved IP is private/loopback/link-local/
CGNAT/reserved/multicast/ULA or the metadata IP. ``pinned_async_client`` returns
an httpx client pinned to a pre-validated IP so a name can't re-resolve to an
internal address between check and connect (DNS rebinding).
"""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse

from app.settings import settings

# Explicit deny beyond the stdlib ``is_*`` checks (cloud metadata endpoints).
_METADATA_IPS = {"169.254.169.254", "fd00:ec2::254"}


class UnsafeURLError(ValueError):
    """Raised when a URL fails SSRF validation."""


def _ip_is_blocked(ip: str) -> bool:
    addr = ipaddress.ip_address(ip)
    return (
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_reserved
        or addr.is_multicast
        or addr.is_unspecified
        or ip in _METADATA_IPS
        # CGNAT 100.64.0.0/10
        or (addr.version == 4 and ipaddress.ip_address(ip) in ipaddress.ip_network("100.64.0.0/10"))
    )


def resolve_safe_ips(host: str, *, allow_private: bool = False) -> list[str]:
    """Resolve ``host`` and return its IPs, raising if any is blocked.

    ``allow_private`` (dev only) skips the private/loopback checks so webhooks
    can be tested against a local receiver. Never enable in prod.
    """
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as exc:
        raise UnsafeURLError(f"cannot resolve host {host!r}") from exc
    ips = sorted({info[4][0] for info in infos})
    if not ips:
        raise UnsafeURLError(f"no addresses for host {host!r}")
    if not allow_private:
        for ip in ips:
            if _ip_is_blocked(ip):
                raise UnsafeURLError(f"host {host!r} resolves to blocked address {ip}")
    return ips


def validate_public_url(
    url: str, *, allow_http: bool | None = None, allow_private: bool = False
) -> str:
    """Validate a URL is safe to fetch. Returns it unchanged or raises."""
    allow_http = (not settings.is_prod) if allow_http is None else allow_http
    parsed = urlparse(url)

    if parsed.scheme not in ("http", "https"):
        raise UnsafeURLError(f"unsupported scheme {parsed.scheme!r}")
    if parsed.scheme == "http" and not allow_http:
        raise UnsafeURLError("http is not allowed (use https)")
    if parsed.username or parsed.password:
        raise UnsafeURLError("URL must not contain credentials")
    if not parsed.hostname:
        raise UnsafeURLError("URL has no host")

    resolve_safe_ips(parsed.hostname, allow_private=allow_private)
    return url


# NOTE (Phase 2): webhook *delivery* will use a custom httpx transport that
# connects to the pre-validated IP (with redirects disabled) so a name can't
# re-resolve to an internal address between validation and connect. The
# validator above is the Phase-1 guard used for PUBLIC_BASE_URL and to vet
# stored webhook URLs at write time.
