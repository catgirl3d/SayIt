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

import { buildReprocessMetadata, reprocessViaCloudApi, reprocessViaLocal } from '../History'

function mockCloudProfile(provider = 'openai_transcribe') {
  mocks.loadActiveAsrProfile.mockResolvedValue({
    id: 'history-asr-profile',
    provider,
    apiKey: 'history-asr-key',
    appId: '',
    model: 'history-asr-model',
    omniPrompt: '',
  })
}

function mockSettings(settings: Record<string, unknown>) {
  let activeSettings = settings
  mocks.getSetting.mockImplementation(async (key: string, fallback: unknown) => (
    activeSettings[key] ?? fallback
  ))
  return (nextSettings: Record<string, unknown>) => { activeSettings = nextSettings }
}

function aiSettings(provider: string, apiUrl: string, apiKey: string, model: string) {
  return {
    'cloudAi.provider': provider,
    'cloudAi.apiUrl': apiUrl,
    'cloudAi.apiKey': apiKey,
    'cloudAi.model': model,
  }
}

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

  it('returns a Deepgram keyterm warning without changing the recognized result or AI outcome', async () => {
    const profile = Object.freeze({
      id: 'deepgram-history-profile',
      provider: 'deepgram',
      apiKey: 'history-asr-key',
      appId: '',
      model: 'nova-3',
      omniPrompt: '',
    })
    const settings = { 'aiEnabled': false }
    mocks.loadActiveAsrProfile.mockResolvedValue(profile)
    mockSettings(settings)
    mocks.invoke.mockResolvedValue({
      text: 'recognized again',
      elapsed_ms: 18,
      warning: 'deepgram_keyterm_limit',
    })

    const result = await reprocessViaCloudApi(
      new ArrayBuffer(32000), ['SayIt'], false, undefined, 'en',
    )

    expect(result).toMatchObject({
      asrText: 'recognized again',
      llmText: 'recognized again',
      aiSource: 'none',
      aiStatus: 'skipped',
      asrWarning: 'deepgram_keyterm_limit',
    })
    expect(profile).toMatchObject({ provider: 'deepgram', model: 'nova-3' })
    expect(settings).toEqual({ aiEnabled: false })
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(['cloud_transcribe'])
  })

  it('ignores a warning returned for a non-Deepgram cloud provider', async () => {
    mockCloudProfile('openai_transcribe')
    mocks.invoke.mockResolvedValue({
      text: 'recognized again',
      elapsed_ms: 18,
      warning: 'deepgram_keyterm_limit',
    })

    const result = await reprocessViaCloudApi(
      new ArrayBuffer(32000), [], false, undefined, 'en',
    )

    expect(result.asrWarning).toBeUndefined()
    expect(result.asrText).toBe('recognized again')
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

  it('runs keyless Ollama and returns its nonempty cleanup', async () => {
    mockCloudProfile()
    mockSettings(aiSettings('ollama', 'http://127.0.0.1:11434', '', 'qwen2.5:7b'))
    mocks.invoke.mockImplementation(async (command: string) => (
      command === 'cloud_transcribe'
        ? { text: 'raw transcript', elapsed_ms: 18 }
        : { text: 'cleaned transcript', elapsed_ms: 7 }
    ))

    const result = await reprocessViaCloudApi(
      new ArrayBuffer(32000), [], true, undefined, 'en',
    )

    expect(mocks.invoke).toHaveBeenCalledWith('cloud_polish', {
      request: expect.objectContaining({
        text: 'raw transcript',
        ai_config: {
          provider: 'ollama',
          api_url: 'http://127.0.0.1:11434',
          api_key: '',
          model: 'qwen2.5:7b',
        },
      }),
    })
    expect(result).toMatchObject({
      llmText: 'cleaned transcript',
      aiSource: 'custom',
      aiStatus: 'applied',
      aiProvider: 'ollama',
      aiModel: 'qwen2.5:7b',
    })
  })

  it('keeps cloud AI result and metadata tied to the configuration used by its request', async () => {
    mockCloudProfile()
    const switchSettings = mockSettings(aiSettings('openai_compat', 'https://a.example/v1', 'key-a', 'model-a'))
    let resolvePolish!: (result: { text: string; elapsed_ms: number }) => void
    let startPolish!: () => void
    const polishStarted = new Promise<void>((resolve) => { startPolish = resolve })
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'cloud_polish') {
        startPolish()
        return new Promise((resolve) => { resolvePolish = resolve })
      }
      return Promise.resolve({ text: 'raw transcript', elapsed_ms: 18 })
    })

    const pending = reprocessViaCloudApi(new ArrayBuffer(32000), [], true, undefined, 'en')
    await polishStarted
    switchSettings(aiSettings('ollama', 'http://localhost:11434', '', 'model-b'))
    resolvePolish({ text: 'raw transcript', elapsed_ms: 0 })
    const result = await pending
    const metadata = await buildReprocessMetadata('cloud_api', result)

    expect(result).toMatchObject({
      llmText: 'raw transcript',
      aiSource: 'custom',
      aiStatus: 'applied',
      aiProvider: 'openai_compat',
      aiModel: 'model-a',
    })
    expect(metadata).toMatchObject({ aiProvider: 'openai_compat', aiModel: 'model-a' })
  })

  it('keeps local AI result and metadata tied to the configuration used by its request', async () => {
    const switchSettings = mockSettings({
      ...aiSettings('openai_compat', 'https://a.example/v1', 'key-a', '  model-a  '),
      'aiEnabled': true,
      'localAsr.modelId': 'local-model-a',
      'localAsr.accelerator': 'auto',
    })
    let resolvePolish!: (result: { text: string; elapsed_ms: number }) => void
    let startPolish!: () => void
    const polishStarted = new Promise<void>((resolve) => { startPolish = resolve })
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'cloud_polish') {
        startPolish()
        return new Promise((resolve) => { resolvePolish = resolve })
      }
      return Promise.resolve({ text: 'local raw transcript', elapsed_ms: 18 })
    })

    const pending = reprocessViaLocal(new ArrayBuffer(32000), [], true, undefined, 'en')
    await polishStarted
    switchSettings({
      ...aiSettings('ollama', 'http://localhost:11434', '', 'model-b'),
      'aiEnabled': true,
      'localAsr.modelId': 'local-model-b',
      'localAsr.accelerator': 'auto',
    })
    resolvePolish({ text: 'cleaned local transcript', elapsed_ms: 12 })
    const result = await pending
    const metadata = await buildReprocessMetadata('local', result)

    expect(result).toMatchObject({
      llmText: 'cleaned local transcript',
      aiSource: 'custom',
      aiStatus: 'applied',
      aiProvider: 'openai_compat',
      aiModel: '  model-a  ',
    })
    expect(metadata).toMatchObject({ aiProvider: 'openai_compat', aiModel: '  model-a  ' })
    expect(mocks.invoke).toHaveBeenCalledWith('cloud_polish', {
      request: expect.objectContaining({
        ai_config: {
          provider: 'openai_compat',
          api_url: 'https://a.example/v1',
          api_key: 'key-a',
          model: '  model-a  ',
        },
      }),
    })
  })

  it('keeps the local Ollama request eligible when its model setting is empty', async () => {
    mockSettings({
      ...aiSettings('ollama', 'http://127.0.0.1:11434', '', ''),
      'localAsr.modelId': 'local-model',
      'localAsr.accelerator': 'auto',
    })
    mocks.invoke.mockImplementation(async (command: string) => (
      command === 'cloud_polish'
        ? { text: 'cleaned local transcript', elapsed_ms: 7 }
        : { text: 'local raw transcript', elapsed_ms: 18 }
    ))

    const result = await reprocessViaLocal(new ArrayBuffer(32000), [], true, undefined, 'en')
    const metadata = await buildReprocessMetadata('local', result)

    expect(mocks.invoke).toHaveBeenCalledWith('cloud_polish', {
      request: expect.objectContaining({
        ai_config: {
          provider: 'ollama',
          api_url: 'http://127.0.0.1:11434',
          api_key: '',
          model: '',
        },
      }),
    })
    expect(result).toMatchObject({ aiSource: 'custom', aiStatus: 'applied', aiProvider: 'ollama' })
    expect(metadata.aiModel).toBeNull()
  })

  it.each([
    {
      name: 'a keyed provider has an empty model',
      provider: 'openai_compat',
      apiUrl: 'https://a.example/v1',
      apiKey: 'key-a',
      model: '',
    },
    {
      name: 'a keyed provider has a whitespace-only model',
      provider: 'openai_compat',
      apiUrl: 'https://a.example/v1',
      apiKey: 'key-a',
      model: ' \t\n ',
    },
    {
      name: 'Ollama has a whitespace-only model',
      provider: 'ollama',
      apiUrl: 'http://127.0.0.1:11434',
      apiKey: '',
      model: ' \t ',
    },
  ])('does not polish local history when $name', async ({ provider, apiUrl, apiKey, model }) => {
    mockSettings({
      ...aiSettings(provider, apiUrl, apiKey, model),
      'localAsr.modelId': 'local-model',
      'localAsr.accelerator': 'auto',
    })
    mocks.invoke.mockImplementation(async (command: string) => (
      command === 'local_transcribe'
        ? { text: 'local raw transcript', elapsed_ms: 18 }
        : { text: 'unexpected cleaned transcript', elapsed_ms: 7 }
    ))

    const result = await reprocessViaLocal(new ArrayBuffer(32000), [], true, undefined, 'en')

    expect(mocks.invoke).toHaveBeenCalledTimes(1)
    expect(mocks.invoke).toHaveBeenCalledWith('local_transcribe', expect.anything())
    expect(mocks.invoke).not.toHaveBeenCalledWith('cloud_polish', expect.anything())
    expect(result).toMatchObject({
      asrText: 'local raw transcript',
      llmText: 'local raw transcript',
      llmMs: 0,
      aiSource: 'custom',
      aiStatus: 'unavailable',
    })
    expect(result.aiProvider).toBeUndefined()
    expect(result.aiModel).toBeUndefined()
  })

  it('does not call a keyed provider when its key is missing', async () => {
    mockCloudProfile()
    mockSettings(aiSettings('openai_compat', 'https://a.example/v1', '', 'model-a'))

    const result = await reprocessViaCloudApi(
      new ArrayBuffer(32000), [], true, undefined, 'en',
    )

    expect(mocks.invoke).toHaveBeenCalledTimes(1)
    expect(mocks.invoke).toHaveBeenCalledWith('cloud_transcribe', expect.anything())
    expect(result).toMatchObject({ aiSource: 'custom', aiStatus: 'unavailable' })
    expect(result.aiProvider).toBeUndefined()
    expect(result.aiModel).toBeUndefined()
  })

  it.each([
    { name: 'disabled AI', aiEnabled: false, asrText: 'raw transcript', asrProvider: 'openai_transcribe' },
    { name: 'empty ASR', aiEnabled: true, asrText: '  ', asrProvider: 'openai_transcribe' },
    { name: 'Qwen Omni ASR', aiEnabled: true, asrText: 'raw transcript', asrProvider: 'qwen_omni_flash' },
  ])('skips separate AI for $name', async ({ aiEnabled, asrText, asrProvider }) => {
    mockCloudProfile(asrProvider)
    mockSettings(aiSettings('ollama', 'http://127.0.0.1:11434', '', 'model-a'))
    mocks.invoke.mockResolvedValue({ text: asrText, elapsed_ms: 18 })

    const result = await reprocessViaCloudApi(
      new ArrayBuffer(32000), [], aiEnabled, undefined, 'en',
    )

    expect(mocks.invoke).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ aiSource: 'none', aiStatus: 'skipped' })
    expect(result.aiProvider).toBeUndefined()
    expect(result.aiModel).toBeUndefined()
  })

  it.each([
    { name: 'rejects', response: () => Promise.reject(new Error('AI request failed')), elapsed: 0 },
    { name: 'returns whitespace', response: () => Promise.resolve({ text: '  \n', elapsed_ms: 13 }), elapsed: 13 },
  ])('falls back to new ASR text and attributes an attempted request that $name', async ({ response, elapsed }) => {
    mockCloudProfile()
    mockSettings(aiSettings('openai_compat', 'https://a.example/v1', 'key-a', 'model-a'))
    mocks.invoke.mockImplementation((command: string) => (
      command === 'cloud_transcribe'
        ? Promise.resolve({ text: 'new raw transcript', elapsed_ms: 18 })
        : response()
    ))

    const result = await reprocessViaCloudApi(
      new ArrayBuffer(32000), [], true, undefined, 'en',
    )

    expect(result).toMatchObject({
      llmText: 'new raw transcript',
      llmMs: elapsed,
      aiSource: 'custom',
      aiStatus: 'failed',
      aiProvider: 'openai_compat',
      aiModel: 'model-a',
    })
  })

  it('serializes skipped AI metadata as explicit nulls to clear prior attribution', async () => {
    mockSettings(aiSettings('ollama', 'http://127.0.0.1:11434', '', 'model-b'))
    const metadata = await buildReprocessMetadata('cloud_api', {
      asrText: 'new raw transcript',
      llmText: 'new raw transcript',
      asrMs: 18,
      llmMs: 0,
      durationSec: 1,
      aiSource: 'none',
      aiStatus: 'skipped',
    })

    expect(JSON.parse(JSON.stringify(metadata))).toMatchObject({
      aiProvider: null,
      aiModel: null,
      aiSource: 'none',
      aiStatus: 'skipped',
    })
  })
})
