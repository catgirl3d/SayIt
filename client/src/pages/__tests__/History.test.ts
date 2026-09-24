import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getSetting: vi.fn(),
  loadActiveAsrProfile: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => mocks.invoke(...args) }))
vi.mock('@/features/settings/asrProfileStore', () => ({
  loadActiveAsrProfile: (...args: unknown[]) => mocks.loadActiveAsrProfile(...args),
}))
vi.mock('@/services/store', () => ({
  countHistory: vi.fn(),
  deleteHistory: vi.fn(),
  listHistory: vi.fn(),
  setHistoryFavorite: vi.fn(),
  updateHistoryRecord: vi.fn(),
  getActivePreset: vi.fn(),
  getSetting: (...args: unknown[]) => mocks.getSetting(...args),
}))

import { reprocessViaCloudApi } from '../History'

describe('history cloud ASR reprocessing', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.getSetting.mockReset()
    mocks.loadActiveAsrProfile.mockReset()
    mocks.invoke.mockResolvedValue({ text: 'recognized again', elapsed_ms: 18 })
  })

  it('sends one selected profile snapshot and reports the model used', async () => {
    mocks.loadActiveAsrProfile.mockResolvedValue({
      id: 'openai-account-b',
      provider: 'openai_transcribe',
      apiKey: 'key-account-b',
      appId: '',
      model: 'whisper-1',
      omniPrompt: '',
    })

    const result = await reprocessViaCloudApi(
      new ArrayBuffer(32000),
      ['SayIt'],
      false,
      undefined,
      'uk',
    )

    expect(mocks.invoke).toHaveBeenCalledWith('cloud_transcribe', {
      request: expect.objectContaining({
        sample_rate: 16000,
        hotwords: ['SayIt'],
        asr_config: {
          provider: 'openai_transcribe',
          api_key: 'key-account-b',
          app_id: '',
          extra: { model: 'whisper-1', language: 'uk' },
        },
      }),
    })
    expect(result.asrModel).toBe('whisper-1')
  })
})
