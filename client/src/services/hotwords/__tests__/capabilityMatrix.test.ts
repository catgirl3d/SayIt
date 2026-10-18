import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))

import { loadAsrHotwordCapabilityMatrix } from '../capabilityMatrix'

describe('loadAsrHotwordCapabilityMatrix', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
  })

  it('returns a valid matrix unchanged and queries the Rust command', async () => {
    const matrix = {
      deepgram: { delivery: 'vocabulary', clientCap: null },
      openai_transcribe: { delivery: 'not_wired_up', clientCap: null },
    }
    mocks.invoke.mockResolvedValueOnce(matrix)

    await expect(loadAsrHotwordCapabilityMatrix()).resolves.toBe(matrix)
    expect(mocks.invoke).toHaveBeenCalledWith('asr_hotword_capability_matrix')
  })

  it('rejects when the command returns null', async () => {
    mocks.invoke.mockResolvedValueOnce(null)

    await expect(loadAsrHotwordCapabilityMatrix()).rejects.toThrow('Invalid ASR hotword capability matrix')
  })

  it('rejects when the command returns a non-object value', async () => {
    mocks.invoke.mockResolvedValueOnce('deepgram')

    await expect(loadAsrHotwordCapabilityMatrix()).rejects.toThrow('Invalid ASR hotword capability matrix')
  })
})
