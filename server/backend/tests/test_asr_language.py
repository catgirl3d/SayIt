"""Regression tests for per-session ASR language aliases."""
from __future__ import annotations

import unittest

from backend.app.asr import ASREngine


class ASRLanguageResolutionTests(unittest.TestCase):
    def _engine(self) -> ASREngine:
        engine = object.__new__(ASREngine)
        engine._language = "Chinese"
        return engine

    def test_resolves_russian_iso_code_to_qwen_language_name(self) -> None:
        self.assertEqual(self._engine()._resolve_language("ru"), "Russian")

    def test_preserves_auto_detection_override(self) -> None:
        self.assertIsNone(self._engine()._resolve_language("auto"))

    def test_missing_override_keeps_configured_default(self) -> None:
        self.assertEqual(self._engine()._resolve_language(None), "Chinese")


if __name__ == "__main__":
    unittest.main()
