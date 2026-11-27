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

import { MAX_CORRECTION_AUDIO_BYTES, submitAsrCorrection, withdrawAsrCorrection } from '../asrCorrection'
import { uint8ArrayToBase64 } from '@/lib/encoding'

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

describe('asr corrections with a configured server', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    runtimeConfig.getBackendBaseUrl.mockReturnValue('https://server.test')
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('submits the decoded audio and reports the server correction id', async () => {
    bridge.readAudioFile.mockResolvedValue('AQIDBAU=')
    bridge.getClientRuntimeInfo.mockResolvedValue({ deviceId: 'device-1', clientVersion: '0.4.0' })
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ correction_id: 'server-id' }),
    })

    const result = await submitAsrCorrection(record, 'corrected text')

    expect(result).toMatchObject({ ok: true, correctionId: 'server-id' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://server.test/api/asr-corrections')
    const audio = (init.body as FormData).get('audio') as Blob
    expect(Array.from(new Uint8Array(await audio.arrayBuffer()))).toEqual([1, 2, 3, 4, 5])
  })

  it('propagates a malformed base64 payload without calling fetch', async () => {
    bridge.readAudioFile.mockResolvedValue('not base64!')

    await expect(submitAsrCorrection(record, 'corrected text')).rejects.toThrow()

    expect(bridge.getClientRuntimeInfo).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('accepts audio exactly at the size limit', async () => {
    bridge.readAudioFile.mockResolvedValue(
      uint8ArrayToBase64(new Uint8Array(MAX_CORRECTION_AUDIO_BYTES)),
    )
    bridge.getClientRuntimeInfo.mockResolvedValue({ deviceId: 'device-1', clientVersion: '0.4.0' })
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ correction_id: 'boundary-id' }),
    })

    const result = await submitAsrCorrection(record, 'corrected text')

    expect(result).toMatchObject({ ok: true, correctionId: 'boundary-id' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects audio above the size limit before calling fetch', async () => {
    bridge.readAudioFile.mockResolvedValue(
      uint8ArrayToBase64(new Uint8Array(MAX_CORRECTION_AUDIO_BYTES + 1)),
    )

    const result = await submitAsrCorrection(record, 'corrected text')

    expect(result).toMatchObject({ ok: false, code: 'audio_too_large' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
