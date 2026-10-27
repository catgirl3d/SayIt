"""Tests for trusted-proxy client IP resolution and HTTP rate limiting."""
from __future__ import annotations

import ipaddress
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.requests import Request
from starlette.websockets import WebSocket

from backend.app.client_ip import (
    ClientIpResolver,
    broad_networks,
    build_client_ip_resolver,
    get_client_ip,
    parse_ip,
    parse_networks,
    real_client_ip,
    websocket_client_ip,
    xff_of,
)
from backend.app.ratelimit import RateLimitMiddleware


def _make_request(
    headers: dict[str, str] | list[tuple[str, str]] | None = None,
    client: tuple[str, int] | None = ("192.0.2.10", 4242),
    app: FastAPI | None = None,
) -> Request:
    header_items = list(headers.items()) if isinstance(headers, dict) else (headers or [])
    scope = {
        "type": "http",
        "http_version": "1.1",
        "method": "GET",
        "path": "/",
        "raw_path": b"/",
        "root_path": "",
        "scheme": "http",
        "query_string": b"",
        "headers": [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in header_items],
        "client": client,
        "server": ("testserver", 80),
    }
    if app is not None:
        scope["app"] = app
    return Request(scope)


def _make_websocket(
    headers: list[tuple[str, str]] | None = None,
    client: tuple[str, int] | None = ("198.51.100.10", 4242),
) -> WebSocket:
    async def receive() -> dict[str, str]:
        return {"type": "websocket.connect"}

    async def send(message: dict[str, object]) -> None:
        return None

    scope = {
        "type": "websocket",
        "path": "/ws/transcribe",
        "raw_path": b"/ws/transcribe",
        "root_path": "",
        "scheme": "ws",
        "query_string": b"",
        "headers": [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in headers or []],
        "client": client,
        "server": ("testserver", 80),
        "subprotocols": [],
    }
    return WebSocket(scope, receive, send)


def _resolver(*cidrs: str) -> ClientIpResolver:
    networks = tuple(ipaddress.ip_network(cidr, strict=False) for cidr in cidrs)
    return ClientIpResolver(networks)


class ClientIpTests(unittest.TestCase):
    def test_parse_ip_accepts_ipv4_ipv6_ports_and_zones(self) -> None:
        self.assertEqual(parse_ip("203.0.113.7"), "203.0.113.7")
        self.assertEqual(parse_ip("203.0.113.7:4242"), "203.0.113.7")
        self.assertEqual(parse_ip("2001:db8::7"), "2001:db8::7")
        self.assertEqual(parse_ip("[2001:db8::7]"), "2001:db8::7")
        self.assertEqual(parse_ip("[2001:db8::7]:4242"), "2001:db8::7")
        self.assertEqual(parse_ip("2001:db8::7%eth0"), "2001:db8::7")

    def test_parse_ip_normalizes_ipv4_mapped_ipv6(self) -> None:
        self.assertEqual(parse_ip("::ffff:192.0.2.7"), "192.0.2.7")
        self.assertEqual(parse_ip("[::ffff:192.0.2.7]:4242"), "192.0.2.7")

    def test_parse_ip_rejects_garbage_and_overlong_entries(self) -> None:
        self.assertIsNone(parse_ip("not-an-ip"))
        self.assertIsNone(parse_ip("203.0.113.7:not-a-port"))
        self.assertIsNone(parse_ip("2001:db8::7%eth0]:not-a-port"))
        self.assertIsNone(parse_ip("2001:db8::7%eth0\x00"))
        self.assertIsNone(parse_ip("x" * 65))

    def test_parse_networks_returns_valid_networks_and_invalid_strings(self) -> None:
        valid, invalid = parse_networks(["203.0.113.0/24", "2001:db8::/32", "not-a-network"])
        self.assertEqual([str(network) for network in valid], ["203.0.113.0/24", "2001:db8::/32"])
        self.assertEqual(invalid, ["not-a-network"])

    def test_xff_of_preserves_multiple_headers_and_drops_empty_values(self) -> None:
        request = _make_request(
            [
                ("x-forwarded-for", "203.0.113.7"),
                ("x-forwarded-for", ""),
                ("x-forwarded-for", "2001:db8::7"),
            ]
        )
        self.assertEqual(xff_of(request.headers), "203.0.113.7, 2001:db8::7")
        self.assertEqual(xff_of({"x-forwarded-for": "203.0.113.7"}), "203.0.113.7")
        self.assertIsNone(xff_of({"x-forwarded-for": "   "}))

    def test_untrusted_peer_ignores_forged_xff(self) -> None:
        self.assertEqual(
            real_client_ip("203.0.113.9", "192.0.2.7", _resolver("198.51.100.0/24").trusted),
            "203.0.113.9",
        )

    def test_trusted_peer_walks_xff_from_right_to_left(self) -> None:
        resolver = _resolver("198.51.100.0/24")
        self.assertEqual(
            resolver.resolve_xff("198.51.100.10", "203.0.113.200, 192.0.2.7, 198.51.100.11"),
            "192.0.2.7",
        )

    def test_trusted_peer_without_xff_returns_peer(self) -> None:
        self.assertEqual(real_client_ip("198.51.100.10", None, _resolver("198.51.100.0/24").trusted), "198.51.100.10")

    def test_blank_xff_entries_are_skipped(self) -> None:
        self.assertEqual(
            real_client_ip(
                "198.51.100.10",
                " , 192.0.2.7, , 198.51.100.11, ",
                _resolver("198.51.100.0/24").trusted,
            ),
            "192.0.2.7",
        )

    def test_unparsable_xff_entry_stops_at_current_address(self) -> None:
        self.assertEqual(
            real_client_ip("198.51.100.10", "invalid, 198.51.100.11", _resolver("198.51.100.0/24").trusted),
            "198.51.100.11",
        )

    def test_all_trusted_xff_entries_return_leftmost_entry(self) -> None:
        self.assertEqual(
            real_client_ip(
                "198.51.100.10",
                "198.51.100.11, 198.51.100.12",
                _resolver("198.51.100.0/24").trusted,
            ),
            "198.51.100.11",
        )

    def test_trusted_hop_walk_is_bounded(self) -> None:
        xff = ", ".join(f"198.51.100.{index}" for index in range(1, 41))
        self.assertEqual(
            real_client_ip("198.51.100.200", xff, _resolver("198.51.100.0/24").trusted),
            "198.51.100.9",
        )

    def test_invalid_peer_returns_raw_peer_and_never_trusts_xff(self) -> None:
        self.assertEqual(real_client_ip("invalid-peer", "203.0.113.7", _resolver("198.51.100.0/24").trusted), "invalid-peer")
        self.assertEqual(real_client_ip(" invalid-peer ", "203.0.113.7", ()), "invalid-peer")
        self.assertEqual(real_client_ip(None, "203.0.113.7", ()), "unknown")

    def test_ipv6_trusted_hop_walk_returns_first_untrusted_entry(self) -> None:
        trusted = _resolver("2001:db8:1::/48").trusted
        self.assertEqual(
            real_client_ip("2001:db8:1::1", "2001:db8:9::5, 2001:db8:1::3, 2001:db8:1::2", trusted),
            "2001:db8:9::5",
        )

    def test_ipv6_untrusted_peer_ignores_xff(self) -> None:
        trusted = _resolver("2001:db8:1::/48").trusted
        self.assertEqual(real_client_ip("2001:db8:2::1", "192.0.2.7", trusted), "2001:db8:2::1")

    def test_bracketed_ipv6_xff_entry_with_port_is_resolved(self) -> None:
        trusted = _resolver("2001:db8:1::/48").trusted
        self.assertEqual(
            real_client_ip("2001:db8:1::1", "[2001:db8:9::5]:4711, 2001:db8:1::2", trusted),
            "2001:db8:9::5",
        )

    def test_trusted_ipv4_network_does_not_trust_ipv6_entries(self) -> None:
        trusted = _resolver("198.51.100.0/24").trusted
        self.assertEqual(real_client_ip("198.51.100.10", "2001:db8::5", trusted), "2001:db8::5")

    def test_ipv4_mapped_peer_matches_ipv4_trusted_network(self) -> None:
        trusted = _resolver("198.51.100.0/24").trusted
        self.assertEqual(real_client_ip("::ffff:198.51.100.10", "192.0.2.7", trusted), "192.0.2.7")

    def test_ipv4_mapped_xff_entries_are_normalized_before_trust_check(self) -> None:
        trusted = _resolver("198.51.100.0/24").trusted
        self.assertEqual(
            real_client_ip("198.51.100.10", "192.0.2.7, ::ffff:198.51.100.2", trusted),
            "192.0.2.7",
        )
        self.assertEqual(real_client_ip("198.51.100.10", "::ffff:192.0.2.7", trusted), "192.0.2.7")

    def test_unparsable_entry_logs_a_bounded_escaped_warning(self) -> None:
        trusted = _resolver("198.51.100.0/24").trusted
        junk = "\x1b[31m" + "x" * 200
        with self.assertLogs("sayit.client_ip", level="WARNING") as logs:
            result = real_client_ip("198.51.100.10", f"192.0.2.7, {junk}", trusted)
        self.assertEqual(result, "198.51.100.10")
        message = logs.output[0]
        self.assertIn("198.51.100.10", message)
        self.assertIn("\\x1b[31m", message)
        self.assertNotIn("\x1b", message)
        self.assertNotIn("x" * 65, message)

    def test_exhausted_hop_limit_logs_warning(self) -> None:
        xff = ", ".join(f"198.51.100.{index}" for index in range(1, 41))
        with self.assertLogs("sayit.client_ip", level="WARNING") as logs:
            real_client_ip("198.51.100.200", xff, _resolver("198.51.100.0/24").trusted)
        self.assertIn("198.51.100.9", logs.output[0])

    def test_resolvable_chains_do_not_log_warnings(self) -> None:
        trusted = _resolver("198.51.100.0/24").trusted
        with self.assertNoLogs("sayit.client_ip", level="WARNING"):
            real_client_ip("203.0.113.9", "192.0.2.7", trusted)
            real_client_ip("198.51.100.10", None, trusted)
            real_client_ip("198.51.100.10", "192.0.2.7, 198.51.100.2", trusted)
            real_client_ip("198.51.100.10", "198.51.100.3, 198.51.100.2", trusted)

    def test_broad_networks_flags_ranges_that_contain_arbitrary_clients(self) -> None:
        networks, invalid = parse_networks(
            ["0.0.0.0/0", "0.0.0.0/1", "8.0.0.0/7", "::/0", "::/1", "2000::/3"]
        )
        self.assertEqual(invalid, [])
        self.assertEqual(broad_networks(networks), list(networks))

    def test_broad_networks_accepts_realistic_proxy_ranges(self) -> None:
        networks, invalid = parse_networks(
            [
                "10.0.0.0/8",
                "172.16.0.0/12",
                "104.16.0.0/13",
                "198.51.100.0/24",
                "127.0.0.1/32",
                "2400:cb00::/32",
                "2a06:98c0::/29",
                "2001:db8::/32",
                "::1/128",
            ]
        )
        self.assertEqual(invalid, [])
        self.assertEqual(broad_networks(networks), [])

    def test_build_resolver_keeps_valid_networks_and_warns_about_invalid_entries(self) -> None:
        with self.assertLogs("sayit.client_ip", level="INFO") as logs:
            resolver = build_client_ip_resolver(["198.51.100.0/24", "not-a-network"])
        self.assertEqual([str(network) for network in resolver.trusted], ["198.51.100.0/24"])
        self.assertEqual([record.levelname for record in logs.records], ["WARNING"])
        self.assertIn("not-a-network", logs.output[0])

    def test_build_resolver_warns_only_about_broad_networks(self) -> None:
        with self.assertLogs("sayit.client_ip", level="INFO") as logs:
            resolver = build_client_ip_resolver(["0.0.0.0/1", "10.0.0.0/8"])
        self.assertEqual(len(resolver.trusted), 2)
        self.assertEqual([record.levelname for record in logs.records], ["WARNING"])
        self.assertIn("0.0.0.0/1", logs.output[0])
        self.assertNotIn("10.0.0.0/8", logs.output[0])

    def test_build_resolver_without_networks_logs_info_not_warning(self) -> None:
        with self.assertLogs("sayit.client_ip", level="INFO") as logs:
            resolver = build_client_ip_resolver([])
        self.assertEqual(resolver.trusted, ())
        self.assertEqual([record.levelname for record in logs.records], ["INFO"])

    def test_build_resolver_with_only_invalid_entries_warns_and_reports_no_networks(self) -> None:
        with self.assertLogs("sayit.client_ip", level="INFO") as logs:
            resolver = build_client_ip_resolver(["not-a-network"])
        self.assertEqual(resolver.trusted, ())
        self.assertEqual([record.levelname for record in logs.records], ["WARNING", "INFO"])

    def test_request_without_app_state_resolver_raises(self) -> None:
        request = _make_request(
            {"x-forwarded-for": "192.0.2.7", "x-real-ip": "192.0.2.8"},
            client=("203.0.113.9", 50000),
        )
        with self.assertRaises(RuntimeError):
            get_client_ip(request)

    def test_request_with_non_resolver_app_state_raises(self) -> None:
        app = FastAPI()
        app.state.client_ip_resolver = object()
        request = _make_request(client=("203.0.113.9", 50000), app=app)
        with self.assertRaises(RuntimeError):
            get_client_ip(request)

    def test_request_state_resolver_uses_xff_but_ignores_x_real_ip(self) -> None:
        app = FastAPI()
        app.state.client_ip_resolver = _resolver("198.51.100.0/24")
        request = _make_request(
            {
                "x-forwarded-for": "192.0.2.7",
                "x-real-ip": "203.0.113.7",
            },
            client=("198.51.100.10", 50000),
            app=app,
        )
        self.assertEqual(get_client_ip(request), "192.0.2.7")

    def test_request_state_resolver_ignores_x_real_ip_without_xff(self) -> None:
        app = FastAPI()
        app.state.client_ip_resolver = _resolver("198.51.100.0/24")
        request = _make_request(
            {"x-real-ip": "192.0.2.7"},
            client=("198.51.100.10", 50000),
            app=app,
        )
        self.assertEqual(get_client_ip(request), "198.51.100.10")


class WebSocketClientIpTests(unittest.TestCase):
    def test_trusted_peer_resolves_across_repeated_xff_headers(self) -> None:
        ws = _make_websocket(
            [
                ("x-forwarded-for", "203.0.113.50, 192.0.2.7"),
                ("x-forwarded-for", "198.51.100.2"),
            ]
        )
        key, forwarded = websocket_client_ip(ws, _resolver("198.51.100.0/24"))
        self.assertEqual(key, "192.0.2.7")
        self.assertEqual(forwarded, "203.0.113.50, 192.0.2.7, 198.51.100.2")

    def test_untrusted_peer_cannot_pin_a_forged_ip(self) -> None:
        ws = _make_websocket([("x-forwarded-for", "192.0.2.7")], client=("203.0.113.9", 4242))
        key, forwarded = websocket_client_ip(ws, _resolver("198.51.100.0/24"))
        self.assertEqual(key, "203.0.113.9")
        self.assertEqual(forwarded, "192.0.2.7")

    def test_default_resolver_trusts_only_the_direct_peer(self) -> None:
        ws = _make_websocket([("x-forwarded-for", "192.0.2.7")])
        key, _ = websocket_client_ip(ws, ClientIpResolver())
        self.assertEqual(key, "198.51.100.10")

    def test_x_real_ip_is_ignored(self) -> None:
        ws = _make_websocket([("x-real-ip", "192.0.2.7")])
        key, forwarded = websocket_client_ip(ws, _resolver("198.51.100.0/24"))
        self.assertEqual(key, "198.51.100.10")
        self.assertIsNone(forwarded)

    def test_missing_client_resolves_to_unknown(self) -> None:
        ws = _make_websocket([("x-forwarded-for", "192.0.2.7")], client=None)
        key, _ = websocket_client_ip(ws, _resolver("198.51.100.0/24"))
        self.assertEqual(key, "unknown")

    def test_websocket_and_http_resolve_the_same_client(self) -> None:
        resolver = _resolver("198.51.100.0/24")
        app = FastAPI()
        app.state.client_ip_resolver = resolver
        headers = [("x-forwarded-for", "203.0.113.50, 192.0.2.7, 198.51.100.2")]
        request = _make_request(headers, client=("198.51.100.10", 4242), app=app)
        ws = _make_websocket(headers, client=("198.51.100.10", 4242))
        self.assertEqual(websocket_client_ip(ws, resolver)[0], get_client_ip(request))


def _rate_limit_app(resolver: ClientIpResolver) -> FastAPI:
    app = FastAPI()
    app.add_middleware(
        RateLimitMiddleware,
        requests_per_minute=0,
        burst=1,
        ip_resolver=resolver,
    )

    @app.get("/limited")
    async def limited() -> dict[str, bool]:
        return {"ok": True}

    return app


class RateLimitClientIpTests(unittest.TestCase):
    def test_untrusted_peer_shares_bucket_across_forged_xff_values(self) -> None:
        app = _rate_limit_app(_resolver("198.51.100.0/24"))
        with TestClient(app, client=("203.0.113.9", 50000)) as client:
            self.assertEqual(client.get("/limited", headers={"x-forwarded-for": "192.0.2.7"}).status_code, 200)
            self.assertEqual(client.get("/limited", headers={"x-forwarded-for": "192.0.2.8"}).status_code, 429)

    def test_trusted_peer_separates_different_real_clients(self) -> None:
        app = _rate_limit_app(_resolver("203.0.113.0/24"))
        with TestClient(app, client=("203.0.113.9", 50000)) as client:
            self.assertEqual(client.get("/limited", headers={"x-forwarded-for": "192.0.2.7"}).status_code, 200)
            self.assertEqual(client.get("/limited", headers={"x-forwarded-for": "192.0.2.8"}).status_code, 200)
            self.assertEqual(client.get("/limited", headers={"x-forwarded-for": "192.0.2.7"}).status_code, 429)


if __name__ == "__main__":
    unittest.main()
