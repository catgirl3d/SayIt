"""Regression tests for the GigaAM decode result adapter."""
from __future__ import annotations

import unittest

import numpy as np
import torch

from backend.app.asr_gigaam import GigaAMASRBackend


class _FakeDecoder:
    def __init__(self, result):
        self.result = result

    def decode(self, head, encoded, encoded_len):
        return self.result


class _FakeModel:
    def __init__(self, decoded):
        self._parameter = torch.zeros(1, dtype=torch.float32)
        self.head = object()
        self.decoding = _FakeDecoder(decoded)

    def parameters(self):
        return iter((self._parameter,))

    def forward(self, wav_tensor, length):
        return torch.zeros((1, 1, 1)), torch.ones(1, dtype=torch.long)


class GigaAMDecodeAdapterTests(unittest.TestCase):
    def _backend(self, decoded):
        backend = object.__new__(GigaAMASRBackend)
        backend._model = _FakeModel(decoded)
        return backend

    def test_extracts_text_from_legacy_string_result(self):
        backend = self._backend(["legacy transcript"])

        result = backend.transcribe_audio(np.full(16000, 0.2, dtype=np.float32))

        self.assertEqual(result, "legacy transcript")

    def test_extracts_text_from_tuple_result(self):
        backend = self._backend([("current transcript", [1, 2], [3, 4])])

        result = backend.transcribe_audio(np.full(16000, 0.2, dtype=np.float32))

        self.assertEqual(result, "current transcript")


if __name__ == "__main__":
    unittest.main()
