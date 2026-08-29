"""ASR engine: Sber GigaAM (v2_rnnt / v2_ctc)."""
from __future__ import annotations

import logging
from pathlib import Path

import numpy as np
import torch

logger = logging.getLogger("sayit.asr.gigaam")


class GigaAMASRBackend:
    """Wraps Sber GigaAM v2 models (v2_rnnt, v2_ctc) for use as a drop-in ASR backend."""

    def __init__(self, model_name: str = "v2_rnnt", device: str = "cuda:0") -> None:
        import gigaam

        if str(device).startswith("cuda") and not torch.cuda.is_available():
            logger.warning("CUDA is not available in current PyTorch build, falling back to CPU for GigaAM")
            device = "cpu"

        self._device = device
        logger.info("Loading GigaAM model=%s on device=%s", model_name, device)

        # PyTorch 2.6+ defaults to weights_only=True, which blocks GigaAM's OmegaConf configs.
        # Temporarily patch torch.load to weights_only=False during model initialization.
        orig_torch_load = torch.load
        def _compat_torch_load(*args, **kwargs):
            kwargs.setdefault("weights_only", False)
            return orig_torch_load(*args, **kwargs)

        torch.load = _compat_torch_load
        try:
            self._model = gigaam.load_model(model_name, device=device)
        finally:
            torch.load = orig_torch_load

        logger.info("GigaAM model=%s ready", model_name)

    def transcribe_audio(self, audio: np.ndarray) -> str:
        """Transcribe a 16kHz float32 or int16 numpy array directly in memory."""
        if len(audio) == 0:
            return ""

        if audio.dtype != np.float32:
            audio = audio.astype(np.float32) / 32768.0

        # Peak normalization for quiet audio
        peak = float(np.max(np.abs(audio)))
        if 0 < peak < 0.1:
            audio = audio * (0.1 / peak)

        audio_clipped = np.clip(audio, -1.0, 1.0)

        device = next(self._model.parameters()).device
        dtype = next(self._model.parameters()).dtype
        wav_tensor = torch.from_numpy(audio_clipped).to(device).to(dtype).unsqueeze(0)
        length = torch.full([1], wav_tensor.shape[-1], device=device)

        with torch.inference_mode():
            encoded, encoded_len = self._model.forward(wav_tensor, length)
            decoded = self._model.decoding.decode(self._model.head, encoded, encoded_len)
            if not decoded:
                return ""
            item = decoded[0]
            text = item[0] if isinstance(item, (tuple, list)) else item
            return str(text).strip()
