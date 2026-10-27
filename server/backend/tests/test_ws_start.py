from __future__ import annotations

import copy

import pytest

from backend.app.client_ip import parse_networks
from backend.app.config import ServerConfig, load_config
from backend.app.ws_start import MAX_LANGUAGE_CHARS, StartLimitError, validate_start_fields


def test_builtin_sized_system_prompt_passes() -> None:
    prompt = "prompt " * 200

    system_prompt, hotwords_context, language = validate_start_fields(
        {"system_prompt": prompt}, ServerConfig()
    )

    assert system_prompt == prompt
    assert hotwords_context is None
    assert language is None


def test_system_prompt_at_cap_passes_and_cap_plus_one_fails() -> None:
    limits = ServerConfig(max_system_prompt_chars=5)

    assert validate_start_fields({"system_prompt": "12345"}, limits) == ("12345", None, None)

    with pytest.raises(StartLimitError) as error:
        validate_start_fields({"system_prompt": "123456"}, limits)

    assert error.value.code == "system_prompt_too_long"
    assert error.value.message == "system_prompt is too long (max 5 characters)"


def test_non_string_system_prompt_is_rejected() -> None:
    with pytest.raises(StartLimitError) as error:
        validate_start_fields({"system_prompt": 42}, ServerConfig())

    assert error.value.code == "invalid_system_prompt"
    assert error.value.message == "system_prompt must be a string"


def test_desktop_maximum_hotwords_pass() -> None:
    hotwords = [str(index) for index in range(1000)]

    system_prompt, hotwords_context, language = validate_start_fields(
        {"hotwords": hotwords}, ServerConfig()
    )

    assert system_prompt is None
    assert hotwords_context == " ".join(hotwords)
    assert language is None


def test_hotword_count_above_limit_is_rejected() -> None:
    with pytest.raises(StartLimitError) as error:
        validate_start_fields(
            {"hotwords": ["word"] * 2001},
            ServerConfig(),
        )

    assert error.value.code == "too_many_hotwords"
    assert error.value.message == "too many hotwords (max 2000)"


def test_hotword_item_length_boundary() -> None:
    limits = ServerConfig(max_hotword_chars=128)

    assert validate_start_fields({"hotwords": ["a" * 128]}, limits) == (None, "a" * 128, None)

    with pytest.raises(StartLimitError) as error:
        validate_start_fields({"hotwords": ["a" * 129]}, limits)

    assert error.value.code == "hotword_too_long"
    assert error.value.message == "hotword is too long (max 128 characters)"


def test_hotword_total_length_boundary_counts_supplied_characters() -> None:
    limits = ServerConfig(max_hotword_chars=10, max_hotwords_total_chars=5)

    assert validate_start_fields({"hotwords": ["aa", "bbb"]}, limits) == (None, "aa bbb", None)

    with pytest.raises(StartLimitError) as error:
        validate_start_fields({"hotwords": ["aaa", "bbb"]}, limits)

    assert error.value.code == "hotwords_too_long"
    assert error.value.message == "hotwords are too long (max 5 characters total)"


def test_non_string_hotword_item_is_rejected() -> None:
    with pytest.raises(StartLimitError) as error:
        validate_start_fields({"hotwords": ["valid", 7]}, ServerConfig())

    assert error.value.code == "invalid_hotwords"
    assert error.value.message == "hotwords must contain only strings"


def test_non_list_hotwords_are_ignored() -> None:
    assert validate_start_fields({"hotwords": "not-a-list"}, ServerConfig()) == (None, None, None)


def test_empty_hotword_list_returns_empty_context() -> None:
    assert validate_start_fields({"hotwords": []}, ServerConfig()) == (None, "", None)


def test_language_passes_through() -> None:
    assert validate_start_fields({"language": "ru"}, ServerConfig()) == (None, None, "ru")


def test_language_is_optional() -> None:
    assert validate_start_fields({}, ServerConfig()) == (None, None, None)


def test_non_string_language_is_rejected() -> None:
    with pytest.raises(StartLimitError) as error:
        validate_start_fields({"language": 42}, ServerConfig())

    assert error.value.code == "invalid_language"
    assert error.value.message == "language must be a string"


def test_language_length_boundary() -> None:
    language = "a" * MAX_LANGUAGE_CHARS

    assert validate_start_fields({"language": language}, ServerConfig()) == (None, None, language)

    with pytest.raises(StartLimitError) as error:
        validate_start_fields({"language": language + "a"}, ServerConfig())

    assert error.value.code == "language_too_long"
    assert error.value.message == f"language is too long (max {MAX_LANGUAGE_CHARS} characters)"


def test_payload_is_not_mutated_on_success_or_failure() -> None:
    payload = {"system_prompt": "prompt", "hotwords": ["one", "two"], "language": "ru"}
    original = copy.deepcopy(payload)

    validate_start_fields(payload, ServerConfig())

    assert payload == original

    invalid_payload = {"system_prompt": "prompt", "hotwords": ["a" * 129], "language": "ru"}
    original_invalid = copy.deepcopy(invalid_payload)
    with pytest.raises(StartLimitError):
        validate_start_fields(
            invalid_payload,
            ServerConfig(max_hotword_chars=128),
        )

    assert invalid_payload == original_invalid


def test_server_config_parses_limits_and_passes_trusted_proxy_entries_through(tmp_path) -> None:
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        """server:
  trusted_proxies:
    - "10.0.0.0/16"
    - "not-a-network"
  max_system_prompt_chars: 1234
  max_hotwords: 0
  max_hotword_chars: "bad"
  max_hotwords_total_chars: 5678
""",
        encoding="utf-8",
    )

    cfg = load_config(config_path=str(config_path))

    assert cfg.server.trusted_proxies == ["10.0.0.0/16", "not-a-network"]
    valid, invalid = parse_networks(cfg.server.trusted_proxies)
    assert [str(network) for network in valid] == ["10.0.0.0/16"]
    assert invalid == ["not-a-network"]
    assert cfg.server.max_system_prompt_chars == 1234
    assert cfg.server.max_hotwords == 2000
    assert cfg.server.max_hotword_chars == 128
    assert cfg.server.max_hotwords_total_chars == 5678


def test_server_config_accepts_scalar_trusted_proxy(tmp_path) -> None:
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        """server:
  trusted_proxies: "10.0.0.0/16"
""",
        encoding="utf-8",
    )

    cfg = load_config(config_path=str(config_path))

    assert cfg.server.trusted_proxies == ["10.0.0.0/16"]


def test_server_config_keeps_non_string_trusted_proxies_for_invalid_reporting(tmp_path) -> None:
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        """server:
  trusted_proxies:
    - "10.0.0.0/16"
    - ~
    - 42
    - ""
""",
        encoding="utf-8",
    )

    cfg = load_config(config_path=str(config_path))

    assert cfg.server.trusted_proxies == ["10.0.0.0/16", "None", "42"]
    valid, invalid = parse_networks(cfg.server.trusted_proxies)
    assert [str(network) for network in valid] == ["10.0.0.0/16"]
    assert invalid == ["None", "42"]


def test_server_config_reports_non_list_trusted_proxies_as_invalid(tmp_path) -> None:
    config_path = tmp_path / "config.yaml"
    config_path.write_text(
        """server:
  trusted_proxies: 42
""",
        encoding="utf-8",
    )

    cfg = load_config(config_path=str(config_path))

    assert cfg.server.trusted_proxies == ["42"]
    assert parse_networks(cfg.server.trusted_proxies)[1] == ["42"]


def test_server_config_without_trusted_proxies_is_empty(tmp_path) -> None:
    config_path = tmp_path / "config.yaml"
    config_path.write_text("server:\n  trusted_proxies:\n", encoding="utf-8")

    cfg = load_config(config_path=str(config_path))

    assert cfg.server.trusted_proxies == []
