"""CORS: no response may carry Access-Control-Allow-Credentials, and the 429/413 responses must carry CORS headers.

Origins stay "*" on purpose: the desktop UI is served from http://tauri.localhost, and a fixed
allowlist would silently break it. Credentials are off because nothing in the clients uses cookies or auth.
Starlette echoes the requesting origin back when the request carries a cookie, so the header that
actually decides whether a browser hands a credentialed response to another site is
Allow-Credentials. That header must be absent everywhere.
"""
from __future__ import annotations

import unittest

from fastapi.testclient import TestClient

from backend.app import main

EVIL = "https://evil.example"
TAURI = "http://tauri.localhost"


class CorsTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app, client=("192.0.2.10", 50000))

    def _assert_no_credentials(self, response):
        self.assertNotIn(
            "access-control-allow-credentials",
            response.headers,
            f"{response.request.method} {response.request.url} carries Access-Control-Allow-Credentials",
        )

    def test_plain_request(self):
        self._assert_no_credentials(self.client.get("/api/notice", headers={"Origin": EVIL}))

    def test_request_with_cookie(self):
        r = self.client.get("/api/notice", headers={"Origin": EVIL, "Cookie": "AWSALB=x"})
        self._assert_no_credentials(r)

    def test_request_with_authorization(self):
        r = self.client.get("/api/notice", headers={"Origin": EVIL, "Authorization": "Basic YTpi"})
        self._assert_no_credentials(r)

    def test_preflight(self):
        r = self.client.options(
            "/api/asr-corrections",
            headers={
                "Origin": EVIL,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type,authorization",
            },
        )
        self._assert_no_credentials(r)

    def test_desktop_client_origin_can_read(self):
        r = self.client.get("/api/notice", headers={"Origin": TAURI})
        self.assertEqual(r.status_code, 200)
        self.assertIn(r.headers.get("access-control-allow-origin"), ("*", TAURI))

    def test_middleware_order_outer_to_inner(self):
        # Starlette: the middleware added LAST is the OUTERMOST. The order in user_middleware is outer -> inner.
        order = [m.cls.__name__ for m in main.app.user_middleware]
        self.assertEqual(order, ["CORSMiddleware", "RateLimitMiddleware", "BodyLimitMiddleware"])

    def test_cors_is_configured_without_credentials(self):
        cors = next(m for m in main.app.user_middleware if m.cls.__name__ == "CORSMiddleware")
        self.assertIs(cors.kwargs["allow_credentials"], False)
        self.assertEqual(cors.kwargs["allow_origins"], ["*"])


if __name__ == "__main__":
    unittest.main()
