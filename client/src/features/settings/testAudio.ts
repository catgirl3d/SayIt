// Shared preparation of the bundled recognition test clip for the Settings test.
//
// The backend expects raw PCM: the WAV header is stripped here and the PCM is
// encoded once for both the cloud request and the server WebSocket path, so the
// two settings components cannot drift apart.

import { invoke } from '@tauri-apps/api/core'
import { uint8ArrayToBase64 } from '@/lib/encoding'
import type { SpeechInputLanguage } from '@/services/speechInputLanguage'

/** Canonical WAV header length of the bundled clips (16 kHz mono PCM16). */
const WAV_HEADER_BYTES = 44

export interface PreparedTestAudio {
  /** Raw PCM as base64, ready for cloud_transcribe. */
  pcmB64: string
  /** Raw PCM bytes, used by the server-mode chunked send. */
  pcmBytes: Uint8Array
  audioSec: number
}

export async function prepareTestPcm(language: SpeechInputLanguage): Promise<PreparedTestAudio> {
  const wavB64 = await invoke<string>('get_test_audio_b64', { language })
  const wavBytes = Uint8Array.from(atob(wavB64), (c) => c.charCodeAt(0))
  const pcmBytes = wavBytes.slice(WAV_HEADER_BYTES)
  return {
    pcmB64: uint8ArrayToBase64(pcmBytes),
    pcmBytes,
    audioSec: pcmBytes.length / 2 / 16000,
  }
}
