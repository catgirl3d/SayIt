"""Resolve client IPs without trusting client-controlled forwarded headers.

The left-most ``X-Forwarded-For`` value is controlled by the client. The AWS
ALB and the optional Node gateway append the real client IP on the right, so
forwarded values are trusted only when the direct peer belongs to a configured
proxy network. HTTP and WebSocket callers use the same right-to-left resolver.
"""
from __future__ import annotations

import ipaddress
import logging
import re
from collections.abc import Iterable
from dataclasses import dataclass
from ipaddress import IPv4Network, IPv6Address, IPv6Network

from starlette.requests import Request
from starlette.websockets import WebSocket

logger = logging.getLogger("sayit.client_ip")

IpNetwork = IPv4Network | IPv6Network
_MAX_IP_TEXT_LENGTH = 64
_MAX_LOGGED_ENTRY_LENGTH = 64
_MAX_TRUSTED_HOPS = 32
# Networks wider than these prefixes cannot be a proxy hop: they contain arbitrary public clients.
# Real proxy ranges are narrower (private VPC blocks up to /8, Cloudflare's IPv4 /13 and IPv6 /29).
_MIN_PROXY_PREFIXLEN = {4: 8, 6: 16}
_PORT_RE = re.compile(r"[0-9]{1,5}\Z")
_ZONE_RE = re.compile(r"[A-Za-z0-9_.-]+\Z")
_XFF_SEPARATOR_RE = re.compile(r"[\s,]+")


def _canonical_address(raw: str) -> str | None:
    if "%" in raw:
        raw, zone = raw.split("%", 1)
        if not _ZONE_RE.fullmatch(zone):
            return None
    try:
        address = ipaddress.ip_address(raw)
    except ValueError:
        return None
    if isinstance(address, IPv6Address):
        mapped = address.ipv4_mapped
        if mapped is not None:
            return str(mapped)
        return str(address)
    return str(address)


def _valid_port(raw: str) -> bool:
    return bool(_PORT_RE.fullmatch(raw)) and int(raw) <= 65535


def parse_ip(raw: object) -> str | None:
    """Return a canonical IP address, accepting common socket address forms."""
    if not isinstance(raw, str):
        return None
    if not raw or len(raw) > _MAX_IP_TEXT_LENGTH:
        return None
    value = raw.strip()
    if not value or len(value) > _MAX_IP_TEXT_LENGTH or any(char.isspace() for char in value):
        return None

    direct = _canonical_address(value)
    if direct is not None:
        return direct

    if value.startswith("["):
        closing = value.find("]")
        if closing < 0:
            return None
        host = value[1:closing]
        suffix = value[closing + 1 :]
        if suffix and (not suffix.startswith(":") or not _valid_port(suffix[1:])):
            return None
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            return None
        if not isinstance(address, IPv6Address):
            return None
        return _canonical_address(host)

    if value.count(":") == 1:
        host, port = value.rsplit(":", 1)
        if not _valid_port(port):
            return None
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            return None
        if not isinstance(address, ipaddress.IPv4Address):
            return None
        return str(address)

    return None


def parse_networks(items: Iterable[object] | None) -> tuple[tuple[IpNetwork, ...], list[str]]:
    """Parse configured proxy networks and return invalid entries separately."""
    if items is None:
        return (), []
    if isinstance(items, str):
        return (), [items]
    try:
        iterator = iter(items)
    except TypeError:
        return (), [str(items)]

    valid: list[IpNetwork] = []
    invalid: list[str] = []
    for raw in iterator:
        if not isinstance(raw, str) or not raw.strip():
            invalid.append(str(raw))
            continue
        try:
            valid.append(ipaddress.ip_network(raw.strip(), strict=False))
        except (TypeError, ValueError):
            invalid.append(raw)
    return tuple(valid), invalid


def broad_networks(networks: Iterable[IpNetwork]) -> list[IpNetwork]:
    """Return networks too wide to be a proxy range; trusting them lets clients forge XFF."""
    return [network for network in networks if network.prefixlen < _MIN_PROXY_PREFIXLEN[network.version]]


def xff_of(headers: object) -> str | None:
    """Join non-empty raw XFF header values without parsing or normalizing them."""
    getlist = getattr(headers, "getlist", None)
    if callable(getlist):
        values = getlist("x-forwarded-for")
    else:
        get = getattr(headers, "get", None)
        value = get("x-forwarded-for") if callable(get) else None
        values = [value]

    nonempty = [value for value in values if isinstance(value, str) and value.strip()]
    return ", ".join(nonempty) or None


def _is_trusted(address: str, trusted_networks: tuple[IpNetwork, ...]) -> bool:
    parsed = ipaddress.ip_address(address)
    for network in trusted_networks:
        if parsed.version != network.version:
            continue
        if parsed in network:
            return True
    return False


def real_client_ip(
    peer: str | None,
    xff: str | None,
    trusted_networks: tuple[IpNetwork, ...],
) -> str:
    """Resolve a client address by walking a trusted XFF suffix right to left."""
    peer_ip = parse_ip(peer)
    if peer_ip is None:
        return peer.strip() if isinstance(peer, str) and peer.strip() else "unknown"
    if not trusted_networks or not _is_trusted(peer_ip, trusted_networks):
        return peer_ip

    current = peer_ip
    if not isinstance(xff, str):
        return current

    trusted_hops = 0
    for raw_entry in reversed(_XFF_SEPARATOR_RE.split(xff)):
        if not raw_entry:
            continue
        parsed = parse_ip(raw_entry)
        if parsed is None:
            logger.warning(
                "X-Forwarded-For entry is not an IP address; using trusted hop %s as the client (entry=%r)",
                current,
                raw_entry[:_MAX_LOGGED_ENTRY_LENGTH],
            )
            return current
        current = parsed
        if not _is_trusted(current, trusted_networks):
            return current
        trusted_hops += 1
        if trusted_hops >= _MAX_TRUSTED_HOPS:
            logger.warning(
                "X-Forwarded-For has %d trusted hops; using trusted hop %s as the client",
                _MAX_TRUSTED_HOPS,
                current,
            )
            return current
    return current


@dataclass(frozen=True, slots=True)
class ClientIpResolver:
    """Resolve HTTP and WebSocket client IPs using one trusted network set."""

    trusted: tuple[IpNetwork, ...] = ()

    def resolve(self, peer: str | None, headers: object) -> str:
        return self.resolve_xff(peer, xff_of(headers))

    def resolve_xff(self, peer: str | None, xff: str | None) -> str:
        return real_client_ip(peer, xff, self.trusted)


def build_client_ip_resolver(trusted_proxies: Iterable[object] | None) -> ClientIpResolver:
    """Build the resolver from configured proxy networks and log configuration problems."""
    trusted_networks, invalid_entries = parse_networks(trusted_proxies)
    for invalid_entry in invalid_entries:
        logger.warning("Ignoring invalid trusted proxy network: %s", invalid_entry)
    for broad_network in broad_networks(trusted_networks):
        logger.warning(
            "server.trusted_proxies contains the broad network %s; every peer inside it is treated as a proxy "
            "and X-Forwarded-For can be forged.",
            broad_network,
        )
    if not trusted_networks:
        logger.info(
            "X-Forwarded-For is ignored; behind a proxy all clients will share the proxy IP because "
            "server.trusted_proxies has no valid entries."
        )
    return ClientIpResolver(trusted_networks)


def get_client_ip(request: Request) -> str:
    """Resolve a request through the resolver the application installed on its state."""
    app = request.scope.get("app")
    resolver = getattr(getattr(app, "state", None), "client_ip_resolver", None)
    if not isinstance(resolver, ClientIpResolver):
        raise RuntimeError("app.state.client_ip_resolver must be set to a ClientIpResolver")
    peer = request.client.host if request.client else None
    return resolver.resolve(peer, request.headers)


def websocket_client_ip(ws: WebSocket, resolver: ClientIpResolver) -> tuple[str, str | None]:
    """Return the resolved client IP and the raw forwarded header of a WebSocket handshake."""
    peer = ws.client.host if ws.client else None
    forwarded_for = xff_of(ws.headers)
    return resolver.resolve_xff(peer, forwarded_for), forwarded_for
