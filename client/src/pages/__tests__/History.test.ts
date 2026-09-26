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

import { buildReprocessMetadata, reprocessViaCloudApi } from '../History'

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

  it('reprocesses with one captured custom profile across Auto fallback and returns provider/model metadata', async () => {
    const profile = {
      id: 'custom-history-profile',
      provider: 'openai_compat',
      baseUrl: 'http://localhost:8090/v1',
      apiKey: 'history-key',
      appId: '',
      model: 'history-audio-model',
      protocol: 'auto',
      omniPrompt: '',
    }
    mocks.loadActiveAsrProfile.mockResolvedValue(profile)
    let rejectFirst!: (reason: string) => void
    let startFirst!: () => void
    const firstStarted = new Promise<void>((resolve) => { startFirst = resolve })
    mocks.invoke.mockImplementationOnce(() => {
      startFirst()
      return new Promise((_resolve, reject) => { rejectFirst = reject })
    }).mockResolvedValueOnce({ text: 'recognized again', elapsed_ms: 18 })

    const pending = reprocessViaCloudApi(
      new ArrayBuffer(32000),
      ['SayIt'],
      false,
      undefined,
      'uk',
    )
    await firstStarted
    profile.baseUrl = 'https://other.example.test/v1'
    profile.apiKey = 'wrong-key'
    profile.model = 'wrong-model'
    rejectFirst('sayit_error:asr_protocol_mismatch:route mismatch')
    const result = await pending

    expect(mocks.invoke).toHaveBeenCalledTimes(2)
    const requests = mocks.invoke.mock.calls.map(([, args]) => (args as {
      request: {
        audio_b64: string
        hotwords: string[]
        asr_config: {
          provider: string
          api_key: string
          extra?: Record<string, unknown>
        }
      }
    }).request)
    expect(requests[0]).toMatchObject({
      hotwords: ['SayIt'],
      asr_config: {
        provider: 'openai_compat',
        api_key: 'history-key',
        extra: { model: 'history-audio-model', base_url: 'http://localhost:8090/v1', protocol: 'transcriptions', language: 'uk' },
      },
    })
    expect(requests[1]).toMatchObject({
      audio_b64: requests[0].audio_b64,
      hotwords: requests[0].hotwords,
      asr_config: {
        provider: 'openai_compat',
        api_key: 'history-key',
        extra: { model: 'history-audio-model', base_url: 'http://localhost:8090/v1', protocol: 'chat', language: 'uk' },
      },
    })
    expect(result).toMatchObject({ asrEngine: 'openai_compat', asrModel: 'history-audio-model' })
  })

  it('stamps the captured provider model on a fixed-model reprocess result', async () => {
    mocks.loadActiveAsrProfile.mockResolvedValue({
      id: 'qwen-history-profile',
      provider: 'qwen',
      apiKey: 'qwen-key',
      appId: '',
      model: 'qwen3-asr-flash',
      omniPrompt: '',
    })

    const result = await reprocessViaCloudApi(
      new ArrayBuffer(32000),
      [],
      false,
      undefined,
      'uk',
    )

    expect(result).toMatchObject({ asrEngine: 'qwen', asrModel: 'qwen3-asr-flash' })
  })

  it('does not relabel cloud reprocess metadata from the runtime provider setting', async () => {
    mocks.getSetting.mockImplementation(async (key: string, fallback: unknown) => (
      key === 'cloudAsr.provider' ? 'groq_whisper' : fallback
    ))

    const meta = await buildReprocessMetadata('cloud_api', {
      asrText: 'recognized again',
      llmText: 'recognized again',
      asrMs: 10,
      llmMs: 0,
      durationSec: 1,
      asrEngine: 'qwen',
    })

    expect(meta.asrProvider).toBe('qwen')
  })
})
