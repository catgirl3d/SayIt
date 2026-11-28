import { beforeEach, describe, expect, it, vi } from 'vitest'

const bridge = vi.hoisted(() => ({ savePcmAsWav: vi.fn() }))

vi.mock('../bridge', () => bridge)

import { saveRecordingAudio } from '../audioFileService'

describe('saveRecordingAudio', () => {
  beforeEach(() => {
    bridge.savePcmAsWav.mockReset()
    bridge.savePcmAsWav.mockResolvedValue('C:/saved.wav')
  })

  it('merges chunks in order and forwards the sample rate', async () => {
    const result = await saveRecordingAudio(
      'record-1',
      [new Uint8Array([1, 2, 3]).buffer, new Uint8Array([4, 5]).buffer],
      48_000,
    )

    expect(result).toBe('C:/saved.wav')
    expect(bridge.savePcmAsWav).toHaveBeenCalledExactlyOnceWith('record-1', 'AQIDBAU=', 48_000)
  })

  it('returns null for empty chunks without calling the bridge', async () => {
    const result = await saveRecordingAudio('record-1', [])

    expect(result).toBeNull()
    expect(bridge.savePcmAsWav).not.toHaveBeenCalled()
  })
})
