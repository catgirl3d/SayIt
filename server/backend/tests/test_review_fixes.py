"""Tests for telemetry edge cases, ratelimit, and config."""
from __future__ import annotations

import shutil
import tempfile
import time
import unittest
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.app.config import Config, TelemetryConfig, LoggingConfig
from backend.app.db import Database
from backend.app.ratelimit import RateLimitMiddleware
from backend.app.telemetry import TelemetryService


# ── Rate limiter tests ──────────────────────────────────────────────

class RateLimitTests(unittest.TestCase):
    def setUp(self) -> None:
        self.app = FastAPI()
        self.app.add_middleware(
            RateLimitMiddleware,
            requests_per_minute=6,
            burst=2,
            exclude_paths=("/healthz",),
        )

        @self.app.get("/healthz")
        async def healthz():
            return {"ok": True}

        @self.app.get("/api/test")
        async def test_endpoint():
            return {"ok": True}

        self.client = TestClient(self.app)

    def test_requests_within_burst_succeed(self) -> None:
        for _ in range(2):
            r = self.client.get("/api/test")
            self.assertEqual(r.status_code, 200)

    def test_exceeding_burst_returns_429(self) -> None:
        for _ in range(3):
            self.client.get("/api/test")
        r = self.client.get("/api/test")
        self.assertEqual(r.status_code, 429)

    def test_excluded_paths_bypass_limit(self) -> None:
        # Exhaust burst on normal endpoint
        for _ in range(5):
            self.client.get("/api/test")
        # Healthz should still work
        r = self.client.get("/healthz")
        self.assertEqual(r.status_code, 200)


# ── Telemetry percentiles / duration_distribution tests ─────────────

class TelemetryQueryTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = Path(tempfile.mkdtemp(prefix="sayit-query-test-"))
        self.cfg = Config(
            telemetry=TelemetryConfig(
                enabled=True,
                db_path=str(self._tmpdir / "sayit.sqlite3"),
                node_id="test-node",
            ),
            logging=LoggingConfig(file=str(self._tmpdir / "backend.log")),
        )
        self.db = Database(self.cfg.telemetry.db_path)
        self.db.initialize()
        self.service = TelemetryService(self.cfg, self.db)

    def tearDown(self) -> None:
        self.db.close()
        shutil.rmtree(self._tmpdir, ignore_errors=True)

    def _insert_session(self, asr_ms: int = 100, llm_ms: int = 50, audio_ms: int = 3000) -> str:
        sid = self.service.create_session(
            connection_id="cid-test",
            client_ip="127.0.0.1",
            forwarded_for=None,
            client_meta={"user_id": "tester"},
            app_context={"process_name": "test.exe"},
        )
        assert sid
        self.service.update_stop(sid, "cid-test", ptt_hold_ms=1000, audio_duration_ms=audio_ms, is_empty_audio=False)
        self.service.record_pipeline_result(
            sid, "cid-test",
            asr_provider="qwen3-asr", asr_model="test-model", asr_lang="zh",
            asr_ms=asr_ms, asr_debug={"timings": {"vad_ms": 5}},
            llm_enabled=True, llm_provider="openai", llm_model="gpt-4o",
            llm_ms=llm_ms, has_result=True,
        )
        return sid

    def test_get_percentiles_empty_db(self) -> None:
        """get_percentiles should not crash on empty database."""
        result = self.service.get_percentiles({})
        self.assertIn("asr_p50", result)

    def test_get_percentiles_with_data(self) -> None:
        for i in range(10):
            self._insert_session(asr_ms=100 * (i + 1), llm_ms=50 * (i + 1))
        result = self.service.get_percentiles({})
        self.assertIsInstance(result["asr_p50"], (int, float))

    def test_duration_distribution_empty_db(self) -> None:
        result = self.service.duration_distribution({})
        self.assertEqual(len(result), 10)
        self.assertTrue(all(item["count"] == 0 for item in result))

    def test_duration_distribution_with_data(self) -> None:
        self._insert_session(audio_ms=3000)
        self._insert_session(audio_ms=8000)
        result = self.service.duration_distribution({})
        counts = {item["label"]: item["count"] for item in result}
        self.assertEqual(counts["0-5s"], 1)
        self.assertEqual(counts["5-10s"], 1)

    def test_metric_by_group(self) -> None:
        self._insert_session()
        result = self.service.metric_by_group({}, "process_name")
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["label"], "test.exe")

    def test_metric_by_group_rejects_invalid_field(self) -> None:
        with self.assertRaises(ValueError):
            self.service.metric_by_group({}, "1; DROP TABLE usage_sessions--")


if __name__ == "__main__":
    unittest.main()
