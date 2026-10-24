"""Removed endpoints stay removed, and internal errors do not leak to clients.

The feedback endpoint and the diagnostics upload were deleted because no client calls them. The
tests check that the routes answer 404/405, that the WebSocket command is gone, and that the
database is never touched. They also cover errors.public_error_message (the fixed client message
plus a reference id) and the LLM debug payload, which must carry only the exception type name.

main.app is used without a `with` block, so the lifespan (ASR model load) does not run.
"""
from __future__ import annotations

import asyncio
import importlib
import json
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi.testclient import TestClient

from backend.app import main
from backend.app.config import LLMProfile
from backend.app.llm import LLMEngine

ORIGIN = "http://tauri.localhost"
NOT_SUPPORTED = (404, 405)


class RemovedHttpEndpointTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app, client=("198.51.100.20", 50000))

    def test_feedback_post_is_not_served_and_writes_nothing(self):
        db = MagicMock()
        body = {"machine_id": "removed-endpoint", "feedback_text": "hello there"}
        with patch.object(main, "database", db):
            r = self.client.post("/api/feedback", json=body, headers={"Origin": ORIGIN})
        self.assertIn(r.status_code, NOT_SUPPORTED, r.text)
        self.assertEqual(db.mock_calls, [], "the removed feedback endpoint must not reach the database")

    def test_diagnostics_upload_is_not_served(self):
        r = self.client.post(
            "/api/diagnostics",
            files={"diagnostics": ("diag.zip", b"PK\x03\x04", "application/zip")},
        )
        self.assertIn(r.status_code, NOT_SUPPORTED, r.text)

    def test_diagnostics_ticket_lookup_is_not_served(self):
        r = self.client.get("/api/diagnostics/" + "a" * 32)
        self.assertIn(r.status_code, NOT_SUPPORTED, r.text)


class RemovedCodeTests(unittest.TestCase):
    def test_main_has_no_feedback_handler(self):
        self.assertFalse(hasattr(main, "post_feedback"))

    def test_diagnostics_module_is_gone(self):
        with self.assertRaises(ModuleNotFoundError):
            importlib.import_module("backend.app.diagnostics")


class RemovedWebSocketCommandTests(unittest.TestCase):
    def test_request_upload_token_is_ignored(self):
        client = TestClient(main.app, client=("198.51.100.21", 50000))
        with client.websocket_connect("/ws/transcribe") as ws:
            ready = ws.receive_json()
            self.assertEqual(ready["type"], "ready")
            ws.send_json({"cmd": "request_upload_token"})
            ws.send_json({"cmd": "ping"})
            reply = ws.receive_json()
            self.assertEqual(reply["type"], "pong", f"expected pong, got {reply!r}")


class PublicErrorMessageTests(unittest.TestCase):
    def test_timeout_gets_timed_out_sentence_with_ref(self):
        from backend.app.errors import public_error_message

        message, ref = public_error_message(TimeoutError("read timed out"), where="pipeline", cid="c1", sid="s1")
        self.assertIn("timed out", message)
        self.assertIn(ref, message)
        self.assertEqual(message, f"Server processing timed out (ref: {ref})")

    def test_generic_error_hides_original_text(self):
        from backend.app.errors import public_error_message

        secret = "C:\\secret\\path"
        message, ref = public_error_message(RuntimeError(secret), where="pipeline", cid="c1", sid="s1")
        self.assertIn(ref, message)
        self.assertNotIn(secret, message)
        self.assertEqual(message, f"Internal server error (ref: {ref})")

    def test_each_error_gets_its_own_ref(self):
        from backend.app.errors import public_error_message

        _, first = public_error_message(RuntimeError("a"), where="pipeline", cid="same", sid="same")
        _, second = public_error_message(RuntimeError("b"), where="pipeline", cid="same", sid="same")
        self.assertNotEqual(first, second)


class LlmDebugPayloadTests(unittest.TestCase):
    def test_failed_provider_call_reports_only_exception_type(self):
        secret = "dial tcp 10.1.2.3:11434 refused at C:\\secret\\path"
        engine = LLMEngine(LLMProfile(enabled=True, provider="ollama"))
        failing = AsyncMock(side_effect=ConnectionError(secret))
        with patch.object(engine, "_call_ollama", failing):
            result, _, debug = asyncio.run(engine.polish("hello"))
        self.assertEqual(result, "hello", "a failed polish must return the original text")
        self.assertEqual(debug, {"error": "ConnectionError"})
        self.assertNotIn(secret, json.dumps(debug))


if __name__ == "__main__":
    unittest.main()
