import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryRecord } from '../store'

const runtimeConfig = vi.hoisted(() => ({
  getBackendBaseUrl: vi.fn(),
  serverNotConfiguredMessage: vi.fn(() => 'Server address is not configured'),
}))
const bridge = vi.hoisted(() => ({
  readAudioFile: vi.fn(),
  getClientRuntimeInfo: vi.fn(),
}))

vi.mock('../runtimeConfig', () => runtimeConfig)
vi.mock('../bridge', () => bridge)

import { submitAsrCorrection, withdrawAsrCorrection } from '../asrCorrection'

const record = {
  id: 'record-1',
  asrText: 'raw text',
  audioFilePath: 'C:/audio.wav',
} as HistoryRecord

describe('asr corrections without a configured server', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runtimeConfig.getBackendBaseUrl.mockReturnValue('')
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejects a submission before touching the network or reading audio', async () => {
    const result = await submitAsrCorrection(record, 'corrected text')

    expect(result).toMatchObject({
      ok: false,
      code: 'server_not_configured',
      message: 'Server address is not configured',
    })
    expect(fetch).not.toHaveBeenCalled()
    expect(bridge.readAudioFile).not.toHaveBeenCalled()
  })

  it('reports a failed withdrawal without touching the network', async () => {
    await expect(withdrawAsrCorrection('c-record-1')).resolves.toBe(false)

    expect(fetch).not.toHaveBeenCalled()
    expect(bridge.getClientRuntimeInfo).not.toHaveBeenCalled()
  })
})
