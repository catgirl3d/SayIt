"""Integration tests for the /ws/transcribe wiring in main.py.

main.py loads its configuration and configures logging at import time, so the module is
imported once with a throwaway config and env file. Telemetry is swapped per test for a
service backed by a temporary database; ASR and LLM engines are never started because
the TestClient is not entered as a context manager and the lifespan does not run.
"""
from __future__ import annotations

import importlib
import ipaddress
import logging
from collections.abc import Iterator
from types import ModuleType
from typing import Any

import pytest
from starlette.testclient import TestClient, WebSocketTestSession

from backend.app.client_ip import ClientIpResolver
from backend.app.config import Config, LoggingConfig, TelemetryConfig
from backend.app.db import Database
from backend.app.ratelimit import RateLimitMiddleware
from backend.app.telemetry import TelemetryService


@pytest.fixture(scope="module")
def main_module(tmp_path_factory: pytest.TempPathFactory) -> Iterator[ModuleType]:
    runtime = tmp_path_factory.mktemp("ws-transcribe")
    config_path = runtime / "config.yaml"
    config_path.write_text(
        "logging:\n"
        f"  file: '{(runtime / 'sayit.log').as_posix()}'\n"
        "telemetry:\n"
        "  enabled: false\n"
        f"  db_path: '{(runtime / 'unused.sqlite3').as_posix()}'\n",
        encoding="utf-8",
    )
    env_path = runtime / ".env"
    env_path.write_text("", encoding="utf-8")

    root = logging.getLogger()
    saved_handlers, saved_level = root.handlers[:], root.level
    with pytest.MonkeyPatch.context() as env:
        env.setenv("SAYIT_CONFIG_FILE", str(config_path))
        env.setenv("SAYIT_ENV_FILE", str(env_path))
        module = importlib.import_module("backend.app.main")
    yield module
    # configure_logging() replaced the root handlers at import; restore them and release the log file.
    for handler in root.handlers:
        if handler not in saved_handlers:
            handler.close()
    root.handlers[:] = saved_handlers
    root.setLevel(saved_level)


@pytest.fixture
def sessions_db(main_module: ModuleType, tmp_path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Database]:
    cfg = Config(
        telemetry=TelemetryConfig(enabled=True, db_path=str(tmp_path / "sayit.sqlite3")),
        logging=LoggingConfig(file=str(tmp_path / "backend.log")),
    )
    db = Database(cfg.telemetry.db_path)
    db.initialize()
    monkeypatch.setattr(main_module, "telemetry_service", TelemetryService(cfg, db))
    yield db
    db.close()


def _sessions(db: Database) -> list[dict[str, Any]]:
    return db.fetch_all("SELECT status, client_ip, forwarded_for FROM usage_sessions ORDER BY rowid")


def _connect(client: TestClient, headers: dict[str, str] | None = None) -> WebSocketTestSession:
    return client.websocket_connect("/ws/transcribe", headers=dict(headers or {}))


def _expect_ready(ws: WebSocketTestSession) -> None:
    assert ws.receive_json()["type"] == "ready"


def _sync(ws: WebSocketTestSession) -> None:
    """Wait until the server has handled every message sent before this ping."""
    ws.send_json({"cmd": "ping"})
    assert ws.receive_json()["type"] == "pong"


def test_http_routes_and_rate_limit_share_the_websocket_resolver(main_module: ModuleType) -> None:
    assert main_module.app.state.client_ip_resolver is main_module.ip_resolver
    rate_limits = [entry for entry in main_module.app.user_middleware if entry.cls is RateLimitMiddleware]
    assert [entry.kwargs["ip_resolver"] for entry in rate_limits] == [main_module.ip_resolver]


def test_session_and_connection_limit_use_client_resolved_through_trusted_proxy(
    main_module: ModuleType, sessions_db: Database, monkeypatch: pytest.MonkeyPatch
) -> None:
    resolver = ClientIpResolver((ipaddress.ip_network("198.51.100.0/24"),))
    monkeypatch.setattr(main_module, "ip_resolver", resolver)
    client = TestClient(main_module.app, client=("198.51.100.10", 50000))

    with _connect(client, {"x-forwarded-for": "203.0.113.50, 192.0.2.7"}) as ws:
        _expect_ready(ws)
        assert "192.0.2.7" in main_module._ws_by_ip
        ws.send_json({"cmd": "start"})
        _sync(ws)

    assert [(row["client_ip"], row["forwarded_for"]) for row in _sessions(sessions_db)] == [
        ("192.0.2.7", "203.0.113.50, 192.0.2.7"),
    ]


def test_untrusted_peer_cannot_set_session_client_ip(main_module: ModuleType, sessions_db: Database) -> None:
    client = TestClient(main_module.app, client=("203.0.113.9", 50000))

    with _connect(client, {"x-forwarded-for": "192.0.2.7"}) as ws:
        _expect_ready(ws)
        ws.send_json({"cmd": "start"})
        _sync(ws)

    assert [row["client_ip"] for row in _sessions(sessions_db)] == ["203.0.113.9"]


def test_second_start_supersedes_open_session(main_module: ModuleType, sessions_db: Database) -> None:
    client = TestClient(main_module.app)

    with _connect(client) as ws:
        _expect_ready(ws)
        ws.send_json({"cmd": "start"})
        _sync(ws)
        ws.send_json({"cmd": "start"})
        _sync(ws)

    assert [row["status"] for row in _sessions(sessions_db)] == ["superseded", "disconnected"]


def test_rejected_start_reports_limit_and_supersedes_open_session(
    main_module: ModuleType, sessions_db: Database
) -> None:
    client = TestClient(main_module.app)
    oversized_prompt = "x" * (main_module.cfg.server.max_system_prompt_chars + 1)

    with _connect(client) as ws:
        _expect_ready(ws)
        ws.send_json({"cmd": "start"})
        _sync(ws)
        ws.send_json({"cmd": "start", "system_prompt": oversized_prompt})
        error = ws.receive_json()
        assert (error["type"], error["code"]) == ("error", "system_prompt_too_long")
        assert ws.receive_json() == {"type": "done"}
        _sync(ws)

    assert [row["status"] for row in _sessions(sessions_db)] == ["superseded"]


def test_rejected_first_start_creates_no_session(main_module: ModuleType, sessions_db: Database) -> None:
    client = TestClient(main_module.app)

    with _connect(client) as ws:
        _expect_ready(ws)
        ws.send_json({"cmd": "start", "hotwords": ["x" * (main_module.cfg.server.max_hotword_chars + 1)]})
        error = ws.receive_json()
        assert (error["type"], error["code"]) == ("error", "hotword_too_long")
        assert ws.receive_json() == {"type": "done"}

    assert _sessions(sessions_db) == []
