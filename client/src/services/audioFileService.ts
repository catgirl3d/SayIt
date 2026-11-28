/**
 * Renderer-side service for saving and loading audio files via IPC.
 */

import * as bridge from './bridge'
import { concatByteChunks } from '@/lib/bytes'
import { uint8ArrayToBase64 } from '@/lib/encoding'
import { PCM_BYTES_PER_SAMPLE, PCM_SAMPLE_RATE } from './pcmFormat'

/**
 * Save PCM chunks (Int16 LE) as WAV file.
 * Rust builds the WAV header; the frontend sends base64-encoded PCM.
 * Returns the saved file path.
 */
export async function saveRecordingAudio(
  id: string,
  chunks: ArrayBuffer[],
  sampleRate = PCM_SAMPLE_RATE,
): Promise<string | null> {
  const totalLen = chunks.reduce((sum, c) => sum + c.byteLength, 0)
  if (totalLen <= 0) return null

  // Safety check: is the PCM amount plausible (16 kHz 16-bit mono = 32000 bytes/sec)
  const expectedBytesPerSec = sampleRate * PCM_BYTES_PER_SAMPLE
  const durationSec = totalLen / expectedBytesPerSec
  if (durationSec > 600) {
    console.warn('[audio] saveRecordingAudio: unusually long audio', {
      totalLen,
      durationSec: durationSec.toFixed(1),
      sampleRate,
      chunkCount: chunks.length,
    })
  }

  // Merge the PCM chunks in arrival order
  const merged = concatByteChunks(chunks)

  // 转 base64 传给 Rust，Rust 侧编码 WAV header 并写入文件
  const pcmBase64 = uint8ArrayToBase64(merged)

  return bridge.savePcmAsWav(id, pcmBase64, sampleRate)
}

/**
 * Load audio file as a data URL for playback.
 */
export async function loadAudioAsDataUrl(filePath: string): Promise<string | null> {
  const base64 = await bridge.readAudioFile(filePath)
  if (!base64) return null
  return `data:audio/wav;base64,${base64}`
}

/**
 * Delete an audio file.
 */
export async function deleteAudioFileFromRenderer(filePath: string): Promise<boolean> {
  return bridge.deleteAudioFile(filePath).then(() => true)
}
