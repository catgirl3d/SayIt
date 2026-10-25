import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => mocks.invoke(...args),
}))
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(),
  listen: vi.fn(),
}))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(),
}))

import { readAudioPcm } from '../bridge'

describe('readAudioPcm', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
  })

  it('returns the ArrayBuffer from the raw read command', async () => {
    const pcm = new ArrayBuffer(4)
    mocks.invoke.mockResolvedValue(pcm)

    await expect(readAudioPcm('C:\\recordings\\sample.wav')).resolves.toBe(pcm)
    expect(mocks.invoke).toHaveBeenCalledWith('read_audio_pcm', { filePath: 'C:\\recordings\\sample.wav' })
  })

  it.each([
    ['a string', 'AAAA'],
    ['a number array', [0, 1, 2, 3]],
  ])('rejects %s instead of converting it', async (_name, result) => {
    mocks.invoke.mockResolvedValue(result)

    await expect(readAudioPcm('C:\\recordings\\sample.wav')).rejects.toThrow(
      'read_audio_pcm returned a non-ArrayBuffer response',
    )
  })
})
