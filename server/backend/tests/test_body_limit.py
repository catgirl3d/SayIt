"""Request body limit (bodylimit.py) and middleware order.

The acceptance criterion is **no business side effects** (no DB writes, no files left on disk),
not "the handler function was never entered": the asr-corrections handler reads the form itself,
and the count is triggered while it reads, so the function is entered either way.
"""
from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
import weakref
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi import FastAPI, File, Request, UploadFile
from fastapi.testclient import TestClient

from backend.app import asr_corrections, main
from backend.app.bodylimit import BodyLimitMiddleware, BodyLimitRule, build_body_limit_rules
from backend.app.config import BodyLimitConfig, _load_body_limits
from backend.app.db import Database

ORIGIN = "http://tauri.localhost"


def _run_asgi(app, *, path: str, chunks: list[bytes], headers: list[tuple[bytes, bytes]] | None = None):
    """Run one request directly through the ASGI protocol, feeding the body chunk by chunk.

    Returns (status, response body, all messages sent by the outer app).
    """
    scope = {
        "type": "http",
        "method": "POST",
        "path": path,
        "query_string": b"",
        "headers": headers or [],
        "client": ("127.0.0.1", 1),
    }
    pending = [{"type": "http.request", "body": c, "more_body": i < len(chunks) - 1} for i, c in enumerate(chunks)]
    sent: list[dict] = []

    async def receive():
        return pending.pop(0) if pending else {"type": "http.disconnect"}

    async def send(message):
        sent.append(message)

    asyncio.run(app(scope, receive, send))
    start = next((m for m in sent if m["type"] == "http.response.start"), None)
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return (start["status"] if start else None), body, sent


class _Recorder:
    """Inner application: reads the body to the end and records whether it completed and how much it read."""

    def __init__(self):
        self.completed = False
        self.got = 0
        self.saw_disconnect = False

    async def __call__(self, scope, receive, send):
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                self.saw_disconnect = True
                await send({"type": "http.response.start", "status": 400, "headers": []})
                await send({"type": "http.response.body", "body": b"inner-400"})
                return
            self.got += len(message.get("body", b""))
            if not message.get("more_body"):
                break
        self.completed = True
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})


def _mw(inner, limit=100):
    return BodyLimitMiddleware(
        inner,
        exact={"/x": BodyLimitRule(limit, {"error": "too_big"})},
        prefixes=[("/bulk/", BodyLimitRule(limit * 2, {"error": "bulk_too_big"}))],
        default=BodyLimitRule(10, {"error": "default_too_big"}),
    )


class MiddlewareUnitTests(unittest.TestCase):
    def test_declared_length_over_limit_rejects_without_reading(self):
        inner = _Recorder()
        status, body, _ = _run_asgi(_mw(inner), path="/x", chunks=[b"a" * 50], headers=[(b"content-length", b"1000")])
        self.assertEqual(status, 413)
        self.assertEqual(json.loads(body), {"error": "too_big"})
        self.assertEqual(inner.got, 0, "when the declared length is already over the limit, the inner app must read no bytes")

    def test_chunked_without_length_is_counted(self):
        inner = _Recorder()
        status, body, sent = _run_asgi(_mw(inner), path="/x", chunks=[b"a" * 60, b"a" * 60, b"a" * 60])
        self.assertEqual(status, 413)
        self.assertFalse(inner.completed)
        self.assertTrue(inner.saw_disconnect, "after the limit is hit the inner app must see a disconnect so parsing stops")
        self.assertNotIn(b"inner-400", body, "the inner app's later 400 must be dropped")
        self.assertEqual(sum(1 for m in sent if m["type"] == "http.response.start"), 1)

    def test_understated_content_length_is_still_caught(self):
        inner = _Recorder()
        status, _, _ = _run_asgi(
            _mw(inner), path="/x", chunks=[b"a" * 80, b"a" * 80], headers=[(b"content-length", b"10")]
        )
        self.assertEqual(status, 413)
        self.assertFalse(inner.completed)

    def test_within_limit_passes_through(self):
        inner = _Recorder()
        status, body, _ = _run_asgi(_mw(inner), path="/x", chunks=[b"a" * 50, b"a" * 50])
        self.assertEqual(status, 200)
        self.assertEqual(body, b"ok")
        self.assertEqual(inner.got, 100)

    def test_rule_selection(self):
        mw = _mw(_Recorder())
        self.assertEqual(mw.rule_for("/x").payload, {"error": "too_big"})
        self.assertEqual(mw.rule_for("/bulk/upload/1/image").payload, {"error": "bulk_too_big"})
        self.assertEqual(mw.rule_for("/bulk").payload, {"error": "bulk_too_big"})
        self.assertEqual(mw.rule_for("/x/withdraw").payload, {"error": "default_too_big"})
        self.assertEqual(mw.rule_for("/bulkier").payload, {"error": "default_too_big"})

    def test_websocket_scope_is_untouched(self):
        called = []

        async def inner(scope, receive, send):
            called.append(scope["type"])

        asyncio.run(_mw(inner)({"type": "websocket", "path": "/ws/transcribe", "headers": []}, None, None))
        self.assertEqual(called, ["websocket"])

    def test_unexpected_error_after_rejection_propagates(self):
        # Only the disconnect we fabricate may be swallowed; a real bug in the inner app must surface
        async def inner(scope, receive, send):
            while (await receive())["type"] != "http.disconnect":
                pass
            raise RuntimeError("boom")

        pending = [
            {"type": "http.request", "body": b"a" * 60, "more_body": True},
            {"type": "http.request", "body": b"a" * 60, "more_body": False},
        ]
        sent: list[dict] = []

        async def receive():
            return pending.pop(0) if pending else {"type": "http.disconnect"}

        async def send(message):
            sent.append(message)

        scope = {
            "type": "http",
            "method": "POST",
            "path": "/x",
            "query_string": b"",
            "headers": [],
            "client": ("127.0.0.1", 1),
        }
        with self.assertRaisesRegex(RuntimeError, "boom"):
            asyncio.run(_mw(inner)(scope, receive, send))
        statuses = [m["status"] for m in sent if m["type"] == "http.response.start"]
        self.assertEqual(statuses, [413], "the 413 must already have been sent before the error propagated")

    def test_json_body_over_limit_is_413_not_an_error(self):
        # request.json() raises ClientDisconnect on the fabricated disconnect; that one must be swallowed
        app = FastAPI()

        @app.post("/j")
        async def j(request: Request):  # pragma: no cover - the handler must not finish when over limit
            await request.json()
            return {"ok": True}

        wrapped = BodyLimitMiddleware(
            app,
            exact={"/j": BodyLimitRule(100, {"error": "too_big"})},
            prefixes=[],
            default=BodyLimitRule(10, {"error": "default"}),
        )
        status, body, sent = _run_asgi(
            wrapped,
            path="/j",
            chunks=[b'{"a":"' + b"x" * 60, b"y" * 60 + b'"}'],
            headers=[(b"content-type", b"application/json")],
        )
        self.assertEqual(status, 413)
        self.assertEqual(json.loads(body), {"error": "too_big"})
        self.assertEqual(sum(1 for m in sent if m["type"] == "http.response.start"), 1)

    def test_log_path_is_escaped_against_log_injection(self):
        # uvicorn percent-decodes the path, so %0A arrives here as a real newline
        with self.assertLogs("sayit.bodylimit", "WARNING") as logs:
            status, _, _ = _run_asgi(_mw(_Recorder()), path="/x\nFORGED", chunks=[b"a" * 200])
        self.assertEqual(status, 413)
        self.assertEqual(len(logs.records), 1)
        message = logs.records[0].getMessage()
        self.assertNotIn("\n", message, "a raw newline in the path would forge a log line")
        self.assertIn(r"path='/x\nFORGED'", message)


class ConfigTests(unittest.TestCase):
    def test_defaults(self):
        c = BodyLimitConfig()
        self.assertEqual(c.asr_corrections, 11 * 1024 * 1024)
        self.assertEqual(c.default, 1024 * 1024)
        self.assertFalse(hasattr(c, "diagnostics"), "the diagnostics endpoint was removed, so its limit is gone")
        self.assertFalse(hasattr(c, "feedback"), "the feedback endpoint was removed, so its limit is gone")
        self.assertFalse(hasattr(c, "admin"), "the fork has no admin dashboard, so there is no admin limit")

    def test_yaml_overrides_and_bad_values(self):
        c = _load_body_limits(
            {
                "asr_corrections_mib": 12,
                "diagnostics_mib": 99,
                "feedback_kib": 1024,
                "default_kib": True,
                "admin_mib": 8,
                "nope": 1,
            }
        )
        self.assertEqual(c.asr_corrections, 12 * 1024 * 1024)
        self.assertEqual(c.default, BodyLimitConfig().default)
        self.assertFalse(hasattr(c, "diagnostics"))
        self.assertFalse(hasattr(c, "feedback"))

    def test_non_mapping_body_limits_fall_back_to_defaults(self):
        # body_limits: 5, a list or a string in YAML must not crash the import of main.py
        for raw in (5, [1, 2], "x"):
            with self.subTest(raw=raw):
                with self.assertLogs("sayit.config", "WARNING") as logs:
                    c = _load_body_limits(raw)
                self.assertEqual(c, BodyLimitConfig())
                self.assertIn(type(raw).__name__, logs.output[0])

    def test_rules_keep_client_error_formats(self):
        rules = build_body_limit_rules(BodyLimitConfig())
        # The desktop client (asrCorrection.ts) shows "recording too large" when error == "audio_too_large"
        self.assertEqual(rules["exact"]["/api/asr-corrections"].payload["error"], "audio_too_large")
        self.assertEqual(set(rules["exact"]), {"/api/asr-corrections"}, "only the asr-corrections submission has an exact rule")
        self.assertEqual(rules["prefixes"], [], "the fork has no prefix-based rules")


class MainAppTests(unittest.TestCase):
    """Run against the real main.app: order, CORS headers, side effects."""

    def setUp(self):
        self.client = TestClient(main.app, client=("127.0.0.1", 50000))

    def _asr_correction_body(self, audio_bytes: int):
        """Multipart body with a correction whose audio is audio_bytes long, yielded in 64 KiB chunks."""
        boundary = "AsrBodyLimitBoundary"
        head = (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"correction_id\"\r\n\r\nabcdefgh\r\n"
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"machine_id\"\r\n\r\nm\r\n"
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"a.wav\"\r\n"
            "Content-Type: audio/wav\r\n\r\n"
        ).encode()
        tail = f"\r\n--{boundary}--\r\n".encode()
        chunk = b"\0" * (64 * 1024)

        def gen():
            yield head
            sent = 0
            while sent < audio_bytes:
                size = min(len(chunk), audio_bytes - sent)
                yield chunk[:size]
                sent += size
            yield tail

        return gen(), {"content-type": f"multipart/form-data; boundary={boundary}"}

    def test_asr_correction_over_limit_has_no_side_effects(self):
        db = MagicMock()
        with tempfile.TemporaryDirectory() as store, tempfile.TemporaryDirectory() as spool, patch.object(
            asr_corrections, "STORAGE_DIR", Path(store)
        ), patch.object(tempfile, "tempdir", spool), patch.object(main, "database", db):
            r = self.client.post(
                "/api/asr-corrections",
                data={"correction_id": "abcdefgh", "machine_id": "m"},
                files={"audio": ("a.wav", b"\0" * (13 * 1024 * 1024), "audio/wav")},
                headers={"Origin": ORIGIN},
            )
            self.assertEqual(r.status_code, 413, r.text)
            self.assertEqual(r.json()["error"], "audio_too_large")
            self.assertIn("access-control-allow-origin", r.headers, "the 413 has no CORS header, so the desktop client only sees a network error")
            self.assertEqual(list(Path(store).iterdir()), [], "an oversize correction must not store any audio file")
            self.assertEqual(list(Path(spool).iterdir()), [], "an oversize correction must not spill to the temp directory")
            self.assertEqual(db.mock_calls, [], "an oversize correction must not touch the database")

    def test_asr_correction_chunked_over_limit_has_no_side_effects(self):
        db = MagicMock()
        body, headers = self._asr_correction_body(13 * 1024 * 1024)
        with tempfile.TemporaryDirectory() as store, tempfile.TemporaryDirectory() as spool, patch.object(
            asr_corrections, "STORAGE_DIR", Path(store)
        ), patch.object(tempfile, "tempdir", spool), patch.object(main, "database", db):
            r = self.client.post(
                "/api/asr-corrections", content=body, headers={**headers, "Origin": ORIGIN}
            )
            self.assertEqual(r.status_code, 413, r.text)
            self.assertEqual(r.json()["error"], "audio_too_large")
            self.assertIn("access-control-allow-origin", r.headers)
            self.assertEqual(list(Path(store).iterdir()), [], "an oversize chunked correction must not store any audio file")
            self.assertEqual(list(Path(spool).iterdir()), [], "an oversize chunked correction must not spill to the temp directory")
            self.assertEqual(db.mock_calls, [], "an oversize chunked correction must not touch the database")

    def test_asr_correction_over_limit_uses_client_error_code(self):
        r = self.client.post(
            "/api/asr-corrections",
            data={"correction_id": "abcdefgh", "machine_id": "m"},
            files={"audio": ("a.wav", b"\0" * (12 * 1024 * 1024), "audio/wav")},
            headers={"Origin": ORIGIN},
        )
        self.assertEqual(r.status_code, 413)
        self.assertEqual(r.json()["error"], "audio_too_large")

    def test_rate_limit_429_has_cors_headers(self):
        # Use a dedicated peer address so this test does not drain the rate-limit bucket shared by other tests
        client = TestClient(main.app, client=("198.51.100.77", 50000))
        statuses = [client.get("/api/notice", headers={"Origin": ORIGIN}) for _ in range(40)]
        limited = [r for r in statuses if r.status_code == 429]
        self.assertTrue(limited, "40 consecutive requests should trigger the rate limiter")
        self.assertIn("access-control-allow-origin", limited[0].headers, "the 429 has no CORS header")

    def test_asr_correction_within_limit_is_stored_through_full_stack(self):
        # A recording close to the handler's own 10 MiB audio cap (about 4.9 minutes) must still pass the
        # 11 MiB outer limit and reach the handler unchanged through CORS, rate limiting and the body limit.
        pcm = b"\x00" * (9 * 1024 * 1024)
        fmt = (
            b"fmt " + (16).to_bytes(4, "little") + (1).to_bytes(2, "little") + (1).to_bytes(2, "little")
            + (16000).to_bytes(4, "little") + (32000).to_bytes(4, "little") + (2).to_bytes(2, "little")
            + (16).to_bytes(2, "little")
        )
        riff_body = b"WAVE" + fmt + b"data" + len(pcm).to_bytes(4, "little") + pcm
        wav = b"RIFF" + len(riff_body).to_bytes(4, "little") + riff_body
        form = {
            "correction_id": "corr-fullstack1",
            "machine_id": "body-limit-fullstack",
            "original_asr_text": "the weather is nice today",
            "corrected_text": "the weather is nice to day",
            "work_mode": "server",
            "app_version": "0.3.2",
            "client_record_id": "rec-fullstack",
            "asr_provider": "Qwen3-ASR-1.7B",
            "language": "en",
            "hotwords": json.dumps(["SayIt"]),
            "consent_version": "1",
        }
        with tempfile.TemporaryDirectory() as tmp:
            storage = Path(tmp) / "asr-corrections"
            db = Database(str(Path(tmp) / "sayit.sqlite3"))
            db.initialize()
            # asr_corrections._get_db prefers app.state.database over main.database
            main.app.state.database = db
            try:
                # Dedicated peer address so the shared rate-limit bucket of the other tests is not used
                client = TestClient(main.app, client=("198.51.100.78", 50000))
                with patch.object(asr_corrections, "STORAGE_DIR", storage):
                    r = client.post(
                        "/api/asr-corrections",
                        data=form,
                        files={"audio": ("rec.wav", wav, "audio/wav")},
                        headers={"Origin": ORIGIN},
                    )
                self.assertEqual(r.status_code, 200, r.text)
                self.assertEqual(r.json()["status"], "received")
                self.assertIn("access-control-allow-origin", r.headers)
                stored = list(storage.rglob("*.wav"))
                self.assertEqual(len(stored), 1, "the accepted correction must be stored")
                self.assertEqual(stored[0].stat().st_size, len(wav), "the body must reach the handler unchanged")
                self.assertEqual(len(db.fetch_all("SELECT * FROM asr_corrections")), 1)
            finally:
                del main.app.state.database
                db.close()


class MultipartTempFileTests(unittest.TestCase):
    """Guards the starlette pin in requirements.txt (starlette >= 1.6.0).

    Multipart aborted mid-way: the temp files the framework created must be closed, and the final answer is 413, not 400/500.
    Starlette 1.6.0 and later close the spooled files themselves when parsing is aborted. The middleware no longer forces
    a garbage collection, so this test fails on starlette < 1.6.0 (verified on 1.4.1), which is the intended signal
    that the pin must not be lowered or that the middleware needs a fix again.
    """

    def test_spooled_files_are_closed(self):
        import starlette.formparsers as fp

        created = []
        real = fp.SpooledTemporaryFile

        def tracking(*args, **kwargs):
            f = real(*args, **kwargs)
            # Keep only a weak reference: a strong one would keep the file alive and hide whether the framework released it
            created.append(weakref.ref(f))
            return f

        app = FastAPI()

        @app.post("/up")
        async def up(file: UploadFile = File(...)):  # pragma: no cover - the handler must not be reached when over limit
            return {"size": len(await file.read())}

        wrapped = BodyLimitMiddleware(
            app,
            exact={"/up": BodyLimitRule(3 * 1024 * 1024, {"error": "too_big"})},
            prefixes=[],
            default=BodyLimitRule(1024, {"error": "default"}),
        )
        boundary = "XyZboundary"

        def gen():
            # Send in chunks with no Content-Length, so the middleware can only count as bytes arrive
            # while the parser is already writing to the temp file
            yield (
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.bin\"\r\n"
                "Content-Type: application/octet-stream\r\n\r\n"
            ).encode()
            for _ in range(5 * 16):
                yield b"\0" * (64 * 1024)
            yield f"\r\n--{boundary}--\r\n".encode()

        # TestClient buffers the whole body before handing it to the app, so it cannot exercise
        # "parsing half done"; feed the ASGI messages chunk by chunk instead
        with patch.object(fp, "SpooledTemporaryFile", tracking):
            status, body, _ = _run_asgi(
                wrapped,
                path="/up",
                chunks=list(gen()),
                headers=[(b"content-type", f"multipart/form-data; boundary={boundary}".encode())],
            )
        self.assertEqual(status, 413, body)
        self.assertTrue(created, "test precondition: the parser should have created a temp file")
        # No gc.collect() is called here or in the middleware: on starlette >= 1.6.0 the parser closes the
        # spooled files when it aborts, so the file must already be closed when the request ends.
        alive_open = [r() for r in created if r() is not None and not r().closed]
        self.assertEqual(alive_open, [], "the temp file was not released after the over-limit abort")


if __name__ == "__main__":
    unittest.main()
