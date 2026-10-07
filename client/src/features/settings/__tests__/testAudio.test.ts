import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => mocks.invoke(...args) }))

import { uint8ArrayToBase64 } from '@/lib/encoding'
import { prepareTestPcm } from '../testAudio'

function wavWithPcm(pcm: Uint8Array): Uint8Array {
  const wav = new Uint8Array(44 + pcm.length)
  wav.set(pcm, 44)
  return wav
}

describe('prepareTestPcm', () => {
  beforeEach(() => mocks.invoke.mockReset())

  it('strips the WAV header, keeps raw PCM, and passes the language to the backend', async () => {
    const pcm = new Uint8Array(32000).fill(7) // one second of 16 kHz mono PCM16
    mocks.invoke.mockResolvedValue(uint8ArrayToBase64(wavWithPcm(pcm)))

    const prepared = await prepareTestPcm('ru')

    expect(mocks.invoke).toHaveBeenCalledWith('get_test_audio_b64', { language: 'ru' })
    expect(prepared.pcmBytes).toEqual(pcm)
    expect(prepared.audioSec).toBe(1)
    expect(prepared.pcmB64).toBe(uint8ArrayToBase64(pcm))
  })

  it('reports an empty result for a truncated file instead of throwing', async () => {
    mocks.invoke.mockResolvedValue(uint8ArrayToBase64(new Uint8Array([82, 73, 70, 70])))

    const prepared = await prepareTestPcm('en')

    expect(prepared.pcmBytes).toHaveLength(0)
    expect(prepared.audioSec).toBe(0)
    expect(prepared.pcmB64).toBe('')
  })
})
