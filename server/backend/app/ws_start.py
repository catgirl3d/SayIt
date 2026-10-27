"""Validation for client-supplied WebSocket start fields.

The values are sent by the caller before any ASR or LLM work and must be
bounded here: system_prompt goes to the server LLM account, hotwords and the
language override go to the ASR context. Keep this module free of FastAPI
imports so it stays unit-testable.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Protocol

MAX_LANGUAGE_CHARS = 64


class _StartLimits(Protocol):
    max_system_prompt_chars: int
    max_hotwords: int
    max_hotword_chars: int
    max_hotwords_total_chars: int


class StartLimitError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(message)


def validate_start_fields(
    payload: object,
    limits: _StartLimits,
) -> tuple[str | None, str | None, str | None]:
    fields = payload if isinstance(payload, Mapping) else {}

    raw_system_prompt = fields.get("system_prompt")
    if raw_system_prompt is None:
        system_prompt = None
    elif not isinstance(raw_system_prompt, str):
        raise StartLimitError("invalid_system_prompt", "system_prompt must be a string")
    elif len(raw_system_prompt) > limits.max_system_prompt_chars:
        raise StartLimitError(
            "system_prompt_too_long",
            f"system_prompt is too long (max {limits.max_system_prompt_chars} characters)",
        )
    else:
        system_prompt = raw_system_prompt

    raw_hotwords = fields.get("hotwords")
    if raw_hotwords is None or not isinstance(raw_hotwords, list):
        hotwords_context = None
    else:
        if len(raw_hotwords) > limits.max_hotwords:
            raise StartLimitError(
                "too_many_hotwords",
                f"too many hotwords (max {limits.max_hotwords})",
            )

        total_chars = 0
        for hotword in raw_hotwords:
            if not isinstance(hotword, str):
                raise StartLimitError("invalid_hotwords", "hotwords must contain only strings")
            if len(hotword) > limits.max_hotword_chars:
                raise StartLimitError(
                    "hotword_too_long",
                    f"hotword is too long (max {limits.max_hotword_chars} characters)",
                )
            total_chars += len(hotword)
            if total_chars > limits.max_hotwords_total_chars:
                raise StartLimitError(
                    "hotwords_too_long",
                    f"hotwords are too long (max {limits.max_hotwords_total_chars} characters total)",
                )

        hotwords_context = " ".join(raw_hotwords)

    raw_language = fields.get("language")
    if raw_language is None:
        language = None
    elif not isinstance(raw_language, str):
        raise StartLimitError("invalid_language", "language must be a string")
    elif len(raw_language) > MAX_LANGUAGE_CHARS:
        raise StartLimitError(
            "language_too_long",
            f"language is too long (max {MAX_LANGUAGE_CHARS} characters)",
        )
    else:
        language = raw_language

    return system_prompt, hotwords_context, language
