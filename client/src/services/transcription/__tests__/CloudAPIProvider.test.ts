import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getSetting: vi.fn(),
  loadActiveAsrProfile: vi.fn(),
  polishWithClientAi: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => mocks.invoke(...args) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('@/services/store', () => ({ getSetting: (...args: unknown[]) => mocks.getSetting(...args) }))
vi.mock('@/features/settings/asrProfileStore', () => ({
  loadActiveAsrProfile: (...args: unknown[]) => mocks.loadActiveAsrProfile(...args),
}))
vi.mock('../debugLog', () => ({ addRuntimeEvent: vi.fn() }))
vi.mock('../clientAiPolish', () => ({
  polishWithClientAi: (...args: unknown[]) => mocks.polishWithClientAi(...args),
}))

import { CloudAPIProvider } from '../CloudAPIProvider'

describe('CloudAPIProvider selected-profile snapshots', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.getSetting.mockReset()
    mocks.loadActiveAsrProfile.mockReset()
    mocks.polishWithClientAi.mockReset()

    mocks.getSetting.mockImplementation(async (key: string, fallback: unknown) => {
      if (key === 'cloudAsr.provider') return 'openai_transcribe'
      if (key === 'cloudAsr.apiKey') return 'stale-runtime-key'
      if (key === 'cloudAsr.appId') return ''
      return fallback
    })
    mocks.invoke.mockImplementation(async (command: string) => (
      command === 'cloud_transcribe' ? { text: 'recognized', elapsed_ms: 24 } : undefined
    ))
    mocks.polishWithClientAi.mockImplementation(async ({ asrText }: { asrText: string }) => ({
      llmText: asrText,
      llmMs: 0,
      aiSource: 'none',
      aiStatus: 'skipped',
    }))
  })

  it("uses each run's selected key and model, not stale runtime credentials", async () => {
    mocks.loadActiveAsrProfile
      .mockResolvedValueOnce({
        id: 'account-a',
        provider: 'openai_transcribe',
        apiKey: 'key-account-a',
        appId: '',
        model: 'gpt-transcribe',
        omniPrompt: '',
      })
      .mockResolvedValueOnce({
        id: 'account-b',
        provider: 'openai_transcribe',
        apiKey: 'key-account-b',
        appId: '',
        model: 'whisper-1',
        omniPrompt: '',
      })

    const provider = new CloudAPIProvider()
    const results: Array<{ asrModel?: string }> = []
    let resolveDone = () => {}
    await provider.connect({
      onFinal: (result) => results.push(result),
      onDone: () => resolveDone(),
    })

    for (const runId of [1, 2]) {
      const done = new Promise<void>((resolve) => { resolveDone = resolve })
      expect(provider.start({ runId, language: 'uk' })).toBe(true)
      provider.sendAudio(new ArrayBuffer(16000))
      expect(provider.stop()).toBe(true)
      await done
    }

    const requests = mocks.invoke.mock.calls
      .filter(([command]) => command === 'cloud_transcribe')
      .map(([, args]) => (args as { request: { asr_config: Record<string, unknown> } }).request.asr_config)

    expect(requests).toEqual([
      {
        provider: 'openai_transcribe',
        api_key: 'key-account-a',
        app_id: '',
        extra: { model: 'gpt-transcribe', language: 'uk' },
      },
      {
        provider: 'openai_transcribe',
        api_key: 'key-account-b',
        app_id: '',
        extra: { model: 'whisper-1', language: 'uk' },
      },
    ])
    expect(results.map((result) => result.asrModel)).toEqual(['gpt-transcribe', 'whisper-1'])
  })

  it('keeps an in-flight run bound to the profile captured at start', async () => {
    let resolveFirstProfile!: (profile: {
      id: string
      provider: string
      apiKey: string
      appId: string
      model: string
      omniPrompt: string
    }) => void
    const firstProfile = new Promise<{
      id: string
      provider: string
      apiKey: string
      appId: string
      model: string
      omniPrompt: string
    }>((resolve) => { resolveFirstProfile = resolve })
    mocks.loadActiveAsrProfile
      .mockReturnValueOnce(firstProfile)
      .mockResolvedValueOnce({
        id: 'account-b',
        provider: 'openai_transcribe',
        apiKey: 'key-account-b',
        appId: '',
        model: 'whisper-1',
        omniPrompt: '',
      })

    const provider = new CloudAPIProvider()
    const models: string[] = []
    let resolveDone = () => {}
    await provider.connect({
      onFinal: (result) => { if (result.asrModel) models.push(result.asrModel) },
      onDone: () => resolveDone(),
    })

    const firstDone = new Promise<void>((resolve) => { resolveDone = resolve })
    expect(provider.start({ runId: 1, language: 'uk' })).toBe(true)
    provider.sendAudio(new ArrayBuffer(16000))
    expect(provider.stop()).toBe(true)
    resolveFirstProfile({
      id: 'account-a',
      provider: 'openai_transcribe',
      apiKey: 'key-account-a',
      appId: '',
      model: 'gpt-transcribe',
      omniPrompt: '',
    })
    await firstDone

    const secondDone = new Promise<void>((resolve) => { resolveDone = resolve })
    expect(provider.start({ runId: 2, language: 'uk' })).toBe(true)
    provider.sendAudio(new ArrayBuffer(16000))
    expect(provider.stop()).toBe(true)
    await secondDone

    const configs = mocks.invoke.mock.calls
      .filter(([command]) => command === 'cloud_transcribe')
      .map(([, args]) => (args as { request: { asr_config: { api_key: string; extra: { model: string } } } }).request.asr_config)
    expect(configs.map(({ api_key, extra }) => [api_key, extra.model])).toEqual([
      ['key-account-a', 'gpt-transcribe'],
      ['key-account-b', 'whisper-1'],
    ])
    expect(models).toEqual(['gpt-transcribe', 'whisper-1'])
  })

  it('does not send a request with stale runtime credentials when the profile snapshot fails', async () => {
    mocks.loadActiveAsrProfile.mockRejectedValueOnce(new Error('activation save failed'))
    const errors: string[] = []
    let resolveDone = () => {}
    const done = new Promise<void>((resolve) => { resolveDone = resolve })
    const provider = new CloudAPIProvider()
    await provider.connect({
      onError: (error) => errors.push(error),
      onDone: () => resolveDone(),
    })

    expect(provider.start({ runId: 1, language: 'uk' })).toBe(true)
    provider.sendAudio(new ArrayBuffer(16000))
    expect(provider.stop()).toBe(true)
    await done

    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'cloud_transcribe')).toEqual([])
    expect(errors).toEqual(['Error: activation save failed'])
  })
})
