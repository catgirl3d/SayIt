"""Shared HTTP client IP extraction tests.

Pins the contract that ratelimit and asr_corrections rely on:
the left-most X-Forwarded-For entry wins, otherwise the direct peer address,
otherwise "unknown". Behind the ALB the direct peer is the proxy address for
every user, so losing the forwarded header silently merges all clients into
one rate-limit bucket.
"""
from __future__ import annotations

import unittest

from starlette.requests import Request

from backend.app.client_ip import get_client_ip


def _make_request(
    headers: dict[str, str] | None = None,
    client: tuple[str, int] | None = ("192.0.2.10", 4242),
) -> Request:
    scope = {
        "type": "http",
        "http_version": "1.1",
        "method": "GET",
        "path": "/",
        "raw_path": b"/",
        "root_path": "",
        "scheme": "http",
        "query_string": b"",
        "headers": [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in (headers or {}).items()],
        "client": client,
        "server": ("testserver", 80),
    }
    return Request(scope)


class ClientIpTests(unittest.TestCase):
    def test_forwarded_for_value_wins(self) -> None:
        request = _make_request({"x-forwarded-for": "203.0.113.7"})
        self.assertEqual(get_client_ip(request), "203.0.113.7")

    def test_forwarded_for_list_uses_leftmost_entry(self) -> None:
        request = _make_request({"x-forwarded-for": "203.0.113.7, 10.0.0.2, 10.0.0.3"})
        self.assertEqual(get_client_ip(request), "203.0.113.7")

    def test_forwarded_for_entries_are_trimmed(self) -> None:
        request = _make_request({"x-forwarded-for": "  203.0.113.7 , 10.0.0.2"})
        self.assertEqual(get_client_ip(request), "203.0.113.7")

    def test_missing_forwarded_for_falls_back_to_direct_client(self) -> None:
        request = _make_request(client=("10.0.0.1", 1234))
        self.assertEqual(get_client_ip(request), "10.0.0.1")

    def test_empty_forwarded_for_falls_back_to_direct_client(self) -> None:
        request = _make_request({"x-forwarded-for": ""}, client=("10.0.0.1", 1234))
        self.assertEqual(get_client_ip(request), "10.0.0.1")

    def test_whitespace_only_forwarded_for_falls_back_to_direct_client(self) -> None:
        request = _make_request({"x-forwarded-for": "   "}, client=("10.0.0.1", 1234))
        self.assertEqual(get_client_ip(request), "10.0.0.1")

    def test_leading_comma_forwarded_for_falls_back_to_direct_client(self) -> None:
        request = _make_request({"x-forwarded-for": ", 203.0.113.7"})
        self.assertEqual(get_client_ip(request), "192.0.2.10")

    def test_no_forwarded_for_and_no_client_returns_unknown(self) -> None:
        request = _make_request(client=None)
        self.assertEqual(get_client_ip(request), "unknown")


if __name__ == "__main__":
    unittest.main()
