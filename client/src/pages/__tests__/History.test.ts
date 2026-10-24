// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '@/i18n'
import { clearRuntimeEvents, getRuntimeEvents } from '@/services/debugLog'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getSetting: vi.fn(),
  loadActiveAsrProfile: vi.fn(),
  listHistory: vi.fn(),
  countHistory: vi.fn(),
  exportHistory: vi.fn(),
  listen: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => mocks.invoke(...args) }))
vi.mock('@/features/settings/asrProfileStore', () => ({
  loadActiveAsrProfile: (...args: unknown[]) => mocks.loadActiveAsrProfile(...args),
}))
vi.mock('@/services/store', () => ({
  countHistory: (...args: unknown[]) => mocks.countHistory(...args),
  clearHistory: vi.fn(),
  deleteHistory: vi.fn(),
  listHistory: (...args: unknown[]) => mocks.listHistory(...args),
  setHistoryFavorite: vi.fn(),
  updateHistoryRecord: vi.fn(),
  getActivePreset: vi.fn(),
  getSetting: (...args: unknown[]) => mocks.getSetting(...args),
}))
vi.mock('@/services/exports', () => ({
  exportHistory: (...args: unknown[]) => mocks.exportHistory(...args),
}))
vi.mock('@/services/bridge', () => ({
  appendDebugLog: (payload: unknown) => mocks.invoke('append_debug_log', { payload }),
  deleteAudioFile: vi.fn(),
  emit: vi.fn(),
  getClientRuntimeInfo: vi.fn().mockResolvedValue(null),
  listen: (...args: unknown[]) => mocks.listen(...args),
  readAudioFile: vi.fn(),
}))

import History, { buildReprocessMetadata, reprocessViaCloudApi, reprocessViaLocal, reprocessViaServer } from '../History'
import * as bridge from '@/services/bridge'
import type { HistoryRecord } from '@/services/store'
import { getRuntimeServerAiSource, setRuntimeServerAiSource } from '@/services/transcription/serverAiSource'

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

/** Native commands without the sayit.log mirror that diagnostics-only events append. */
function invokedCommands(): string[] {
  return mocks.invoke.mock.calls
    .map(([command]) => command as string)
    .filter((command) => command !== 'append_debug_log')
}

describe('history export attempt handling', () => {
  beforeEach(() => {
    mocks.listHistory.mockReset().mockResolvedValue([])
    mocks.countHistory.mockReset().mockResolvedValue(0)
    mocks.exportHistory.mockReset().mockResolvedValue({ canceled: true, filePath: null })
    mocks.listen.mockReset().mockResolvedValue(() => undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('does not let an older export timer hide a newer result', async () => {
    vi.useFakeTimers()
    mocks.exportHistory
      .mockReset()
      .mockResolvedValueOnce({ canceled: false, filePath: 'first-export.json' })
      .mockResolvedValueOnce({ canceled: false, filePath: 'second-export.json' })

    render(createElement(History))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    const exportButton = screen.getByRole('button', { name: t('history.export') })

    fireEvent.click(exportButton)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText(t('history.savedTo', { path: 'first-export.json' }))).toBeTruthy()

    await act(async () => { vi.advanceTimersByTime(4_000) })
    fireEvent.click(exportButton)
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText(t('history.savedTo', { path: 'second-export.json' }))).toBeTruthy()

    await act(async () => { vi.advanceTimersByTime(4_000) })
    expect(screen.getByText(t('history.savedTo', { path: 'second-export.json' }))).toBeTruthy()

    await act(async () => { vi.advanceTimersByTime(4_000) })
    expect(screen.queryByText(t('history.savedTo', { path: 'second-export.json' }))).toBeNull()
  })
})

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
    expect(invokedCommands()).toEqual(['cloud_transcribe'])
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

    // The ai.outcome record is mirrored to the main log through append_debug_log; only the ASR calls matter here.
    const asrCalls = mocks.invoke.mock.calls.filter(([command]) => command !== 'append_debug_log')
    expect(asrCalls).toHaveLength(2)
    const requests = asrCalls.map(([, args]) => (args as {
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

  it('uses the cleanup configuration active when ASR finishes for both the request and its attribution', async () => {
    mockCloudProfile()
    const switchSettings = mockSettings(aiSettings('openai_compat', 'https://a.example/v1', 'key-a', 'model-a'))
    let resolveAsr!: (result: { text: string; elapsed_ms: number }) => void
    let startAsr!: () => void
    const asrStarted = new Promise<void>((resolve) => { startAsr = resolve })
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'cloud_transcribe') {
        startAsr()
        return new Promise((resolve) => { resolveAsr = resolve })
      }
      return Promise.resolve({ text: 'cleaned transcript', elapsed_ms: 7 })
    })

    const pending = reprocessViaCloudApi(new ArrayBuffer(32000), [], true, undefined, 'en')
    await asrStarted
    switchSettings(aiSettings('ollama', 'http://localhost:11434', '', 'model-b'))
    resolveAsr({ text: 'raw transcript', elapsed_ms: 18 })
    const result = await pending

    expect(result).toMatchObject({
      llmText: 'cleaned transcript',
      aiSource: 'custom',
      aiStatus: 'applied',
      aiProvider: 'ollama',
      aiModel: 'model-b',
    })
    expect(mocks.invoke).toHaveBeenCalledWith('cloud_polish', {
      request: expect.objectContaining({
        text: 'raw transcript',
        ai_config: expect.objectContaining({ provider: 'ollama', model: 'model-b' }),
      }),
    })
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

  it.each([
    { name: 'empty', model: '' },
    { name: 'whitespace-only', model: ' \t ' },
  ])('keeps the local Ollama request eligible when its model setting is $name', async ({ model }) => {
    mockSettings({
      ...aiSettings('ollama', 'http://127.0.0.1:11434', '', model),
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
    expect(result.aiModel).toBeUndefined()
    expect(metadata.aiModel).toBeNull()
  })

  it.each([
    { name: 'a keyed provider has an empty model', provider: 'openai_compat', apiUrl: 'https://a.example/v1', apiKey: 'key-a', model: '' },
    { name: 'a keyed provider has a whitespace-only model', provider: 'openai_compat', apiUrl: 'https://a.example/v1', apiKey: 'key-a', model: ' \t\n ' },
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

    expect(invokedCommands()).toEqual(['local_transcribe'])
    expect(mocks.invoke).not.toHaveBeenCalledWith('cloud_polish', expect.anything())
    expect(result).toMatchObject({
      asrText: 'local raw transcript',
      llmText: 'local raw transcript',
      llmMs: 0,
      aiSource: 'custom',
      aiStatus: 'unavailable',
      aiProvider: provider,
    })
    expect(result.aiModel).toBeUndefined()
  })

  it('does not call a keyed provider when its key is missing', async () => {
    mockCloudProfile()
    mockSettings(aiSettings('openai_compat', 'https://a.example/v1', '', 'model-a'))

    const result = await reprocessViaCloudApi(
      new ArrayBuffer(32000), [], true, undefined, 'en',
    )
    const metadata = await buildReprocessMetadata('cloud_api', result)

    expect(invokedCommands()).toEqual(['cloud_transcribe'])
    expect(mocks.invoke).not.toHaveBeenCalledWith('cloud_polish', expect.anything())
    expect(mocks.invoke).toHaveBeenCalledWith('append_debug_log', {
      payload: expect.objectContaining({ kind: 'runtime', level: 'warn', source: 'history' }),
    })
    expect(result).toMatchObject({
      aiSource: 'custom',
      aiStatus: 'unavailable',
      aiProvider: 'openai_compat',
      aiModel: 'model-a',
    })
    expect(metadata).toMatchObject({ aiProvider: 'openai_compat', aiModel: 'model-a' })
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

    expect(invokedCommands()).toHaveLength(1)
    expect(result).toMatchObject({ aiSource: 'none', aiStatus: 'skipped' })
    expect(result.aiProvider).toBeUndefined()
    expect(result.aiModel).toBeUndefined()
  })

  it.each([
    { name: 'the request fails', response: () => Promise.reject(new Error('AI request failed')) },
    { name: 'the native layer rejects a blank completion', response: () => Promise.reject(new Error('sayit_error:connect_failed:AI returned no usable completion text')) },
  ])('falls back to new ASR text and attributes an attempted request when $name', async ({ response }) => {
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
      llmMs: 0,
      aiSource: 'custom',
      aiStatus: 'failed',
      aiProvider: 'openai_compat',
      aiModel: 'model-a',
    })
  })

  it.each([
    { name: 'cloud API', run: () => reprocessViaCloudApi(new ArrayBuffer(32000), [], true, undefined, 'en'), asrCommand: 'cloud_transcribe' },
    { name: 'local', run: () => reprocessViaLocal(new ArrayBuffer(32000), [], true, undefined, 'en'), asrCommand: 'local_transcribe' },
  ])('skips cleanup below the minimum-duration threshold in $name reprocessing', async ({ run, asrCommand }) => {
    mockCloudProfile()
    mockSettings({
      ...aiSettings('ollama', 'http://127.0.0.1:11434', '', 'qwen2.5:7b'),
      'aiMinDurationSec': 10,
      'localAsr.modelId': 'local-model',
      'localAsr.accelerator': 'auto',
    })
    mocks.invoke.mockImplementation(async () => ({ text: 'raw transcript', elapsed_ms: 18 }))

    const result = await run()

    expect(invokedCommands()).toHaveLength(1)
    expect(mocks.invoke).toHaveBeenCalledWith(asrCommand, expect.anything())
    expect(mocks.invoke).not.toHaveBeenCalledWith('cloud_polish', expect.anything())
    expect(result).toMatchObject({
      asrText: 'raw transcript',
      llmText: 'raw transcript',
      llmMs: 0,
      aiSource: 'none',
      aiStatus: 'skipped',
    })
    expect(result.aiProvider).toBeUndefined()
  })

  it('runs cleanup when the audio exactly matches the minimum-duration threshold', async () => {
    mockCloudProfile()
    mockSettings({
      ...aiSettings('ollama', 'http://127.0.0.1:11434', '', 'qwen2.5:7b'),
      'aiMinDurationSec': 10,
    })
    mocks.invoke.mockImplementation(async (command: string) => (
      command === 'cloud_polish'
        ? { text: 'cleaned transcript', elapsed_ms: 7 }
        : { text: 'raw transcript', elapsed_ms: 18 }
    ))

    // 10 seconds of 16 kHz mono PCM: the threshold skips only shorter audio.
    const result = await reprocessViaCloudApi(new ArrayBuffer(320000), [], true, undefined, 'en')

    expect(mocks.invoke).toHaveBeenCalledWith('cloud_polish', expect.anything())
    expect(result).toMatchObject({ llmText: 'cleaned transcript', aiStatus: 'applied' })
  })

  it('keeps the raw transcript when cleanup exceeds the shared timeout', async () => {
    mockCloudProfile()
    mockSettings(aiSettings('openai_compat', 'https://a.example/v1', 'key-a', 'model-a'))
    mocks.invoke.mockImplementation((command: string) => (
      command === 'cloud_polish'
        ? new Promise(() => { /* the native request never settles */ })
        : Promise.resolve({ text: 'raw transcript', elapsed_ms: 18 })
    ))

    vi.useFakeTimers()
    try {
      const pending = reprocessViaCloudApi(new ArrayBuffer(32000), [], true, undefined, 'en')
      await vi.advanceTimersByTimeAsync(8001)
      const result = await pending

      expect(result).toMatchObject({
        llmText: 'raw transcript',
        llmMs: 0,
        aiSource: 'custom',
        aiStatus: 'failed',
        aiProvider: 'openai_compat',
        aiModel: 'model-a',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the recognized local text when cleanup exceeds the shared timeout', async () => {
    mockSettings({
      ...aiSettings('openai_compat', 'https://a.example/v1', 'key-a', 'model-a'),
      'localAsr.modelId': 'local-model',
      'localAsr.accelerator': 'auto',
    })
    mocks.invoke.mockImplementation((command: string) => (
      command === 'cloud_polish'
        ? new Promise(() => { /* the native request never settles */ })
        : Promise.resolve({ text: 'local raw transcript', elapsed_ms: 18 })
    ))

    vi.useFakeTimers()
    try {
      const pending = reprocessViaLocal(new ArrayBuffer(32000), [], true, undefined, 'en')
      await vi.advanceTimersByTimeAsync(8001)
      const result = await pending

      expect(result).toMatchObject({
        asrText: 'local raw transcript',
        llmText: 'local raw transcript',
        llmMs: 0,
        aiSource: 'custom',
        aiStatus: 'failed',
        aiProvider: 'openai_compat',
        aiModel: 'model-a',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('serializes skipped AI metadata as explicit nulls to clear prior attribution', async () => {
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

  it.each([
    { name: 'cloud API', run: () => reprocessViaCloudApi(new ArrayBuffer(32000), [], true, undefined, 'en') },
    { name: 'local', run: () => reprocessViaLocal(new ArrayBuffer(32000), [], true, undefined, 'en') },
  ])('sends no selection context with the cleanup request in $name reprocessing', async ({ run }) => {
    mockCloudProfile()
    mockSettings({
      ...aiSettings('openai_compat', 'https://a.example/v1', 'key-a', 'model-a'),
      'localAsr.modelId': 'local-model',
      'localAsr.accelerator': 'auto',
    })
    mocks.invoke.mockImplementation(async (command: string) => (
      command === 'cloud_polish'
        ? { text: 'cleaned transcript', elapsed_ms: 7 }
        : { text: 'raw transcript', elapsed_ms: 18 }
    ))

    const result = await run()

    expect(mocks.invoke).toHaveBeenCalledWith('cloud_polish', {
      request: expect.objectContaining({ text: 'raw transcript', text_context: null }),
    })
    expect(result).toMatchObject({ llmText: 'cleaned transcript', aiStatus: 'applied' })
  })

  it('keeps the recognized local text and skips cleanup when AI is disabled', async () => {
    mockSettings({
      ...aiSettings('openai_compat', 'https://a.example/v1', 'key-a', 'model-a'),
      'aiEnabled': false,
      'localAsr.modelId': 'local-model',
      'localAsr.accelerator': 'auto',
    })
    mocks.invoke.mockImplementation(async (command: string) => (
      command === 'local_transcribe'
        ? { text: 'local raw transcript', elapsed_ms: 18 }
        : { text: 'unexpected cleaned transcript', elapsed_ms: 7 }
    ))

    const result = await reprocessViaLocal(new ArrayBuffer(32000), [], false, undefined, 'en')

    expect(invokedCommands()).toEqual(['local_transcribe'])
    expect(result).toMatchObject({
      asrText: 'local raw transcript',
      llmText: 'local raw transcript',
      llmMs: 0,
      aiSource: 'none',
      aiStatus: 'skipped',
    })
    expect(result.aiProvider).toBeUndefined()
    expect(result.aiModel).toBeUndefined()
  })

  it('keeps the recognized cloud text when the keyed profile is incomplete', async () => {
    mockCloudProfile()
    mockSettings(aiSettings('openai_compat', 'https://a.example/v1', '', 'model-a'))

    const result = await reprocessViaCloudApi(
      new ArrayBuffer(32000), [], true, undefined, 'en',
    )

    expect(mocks.invoke).not.toHaveBeenCalledWith('cloud_polish', expect.anything())
    expect(result).toMatchObject({
      asrText: 'recognized again',
      llmText: 'recognized again',
      llmMs: 0,
      aiSource: 'custom',
      aiStatus: 'unavailable',
    })
  })

  it('keeps the recognized local text when the cleanup request is rejected', async () => {
    mockSettings({
      ...aiSettings('openai_compat', 'https://a.example/v1', 'key-a', 'model-a'),
      'localAsr.modelId': 'local-model',
      'localAsr.accelerator': 'auto',
    })
    mocks.invoke.mockImplementation((command: string) => (
      command === 'cloud_polish'
        ? Promise.reject(new Error('AI request failed'))
        : Promise.resolve({ text: 'local raw transcript', elapsed_ms: 18 })
    ))

    const result = await reprocessViaLocal(new ArrayBuffer(32000), [], true, undefined, 'en')

    expect(result).toMatchObject({
      asrText: 'local raw transcript',
      llmText: 'local raw transcript',
      llmMs: 0,
      aiSource: 'custom',
      aiStatus: 'failed',
      aiProvider: 'openai_compat',
      aiModel: 'model-a',
    })
  })
})

describe('history server reprocessing metadata', () => {
  it.each([
    { aiSource: 'custom', aiProvider: 'ollama', expected: 'ollama' },
    { aiSource: 'custom', aiProvider: '', expected: null },
    { aiSource: 'none', aiProvider: undefined, expected: null },
    { aiSource: 'server', aiProvider: undefined, expected: 'server' },
    { aiSource: undefined, aiProvider: undefined, expected: 'server' },
  ] as const)('attributes server aiSource $aiSource with provider $aiProvider to $expected', async ({ aiSource, aiProvider, expected }) => {
    const meta = await buildReprocessMetadata('server', {
      asrText: 'raw server transcript',
      llmText: 'raw server transcript',
      asrMs: 10,
      llmMs: 0,
      durationSec: 1,
      aiSource,
      aiProvider,
    })

    expect(meta.aiProvider).toBe(expected)
  })
})

/** 1 second of 16 kHz mono 16-bit PCM. */
const ONE_SECOND_RECORDING_BYTES = 32000

type FakeFinalPayload = Record<string, unknown>

/** Minimal WebSocket: opens on the next microtask and answers {cmd:'stop'} with a configured 'final' message. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static finalPayload: FakeFinalPayload = {}

  readonly url: string
  binaryType = 'blob'
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((ev: { code: number }) => void) | null = null
  readonly sentText: string[] = []

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
    queueMicrotask(() => this.onopen?.())
  }

  send(data: string | ArrayBuffer): void {
    if (typeof data !== 'string') return
    this.sentText.push(data)
    const message = JSON.parse(data) as { cmd?: string }
    if (message.cmd === 'stop') {
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: 'final', ...FakeWebSocket.finalPayload }) }))
    }
  }

  close(): void {
    this.onclose?.({ code: 1000 })
  }
}

function setServerFinal(payload: FakeFinalPayload) {
  FakeWebSocket.finalPayload = payload
}

function sentStartMessage(): Record<string, unknown> {
  const first = FakeWebSocket.instances[0]?.sentText[0]
  if (first === undefined) throw new Error('History server reprocessing did not send a start message')
  return JSON.parse(first) as Record<string, unknown>
}

describe('history server reprocessing', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.getSetting.mockReset()
    mocks.invoke.mockResolvedValue({ text: 'cleaned by custom', elapsed_ms: 7 })
    FakeWebSocket.instances = []
    setServerFinal({ asr_text: 'raw server transcript', llm_text: 'raw server transcript', asr_ms: 10, llm_ms: 0, duration_sec: 1 })
    vi.stubGlobal('WebSocket', FakeWebSocket)
    // The Node test environment has no window; reprocessViaServer only uses window.setTimeout.
    vi.stubGlobal('window', globalThis)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([
    { name: 'an unset', source: undefined },
    { name: 'a managed', source: 'managed' },
  ])('sends the cleanup request to the managed server route for $name source', async ({ source }) => {
    mockSettings({ 'server.aiSource': source })
    setServerFinal({
      asr_text: 'raw server transcript',
      llm_text: 'cleaned server transcript',
      asr_ms: 10,
      llm_ms: 42,
      duration_sec: 1,
      asr_engine: 'whisper',
      asr_model: 'base',
    })

    const result = await reprocessViaServer(new ArrayBuffer(ONE_SECOND_RECORDING_BYTES), [], true, 'Be concise', null, 'en')

    expect(sentStartMessage()).toMatchObject({
      cmd: 'start',
      source: 'history_reprocess',
      disable_ai: false,
      language: 'en',
      system_prompt: 'Be concise',
    })
    expect(result).toMatchObject({
      asrText: 'raw server transcript',
      llmText: 'cleaned server transcript',
      llmMs: 42,
      aiSource: 'server',
      aiStatus: 'applied',
      aiProvider: 'server',
    })
    expect(invokedCommands()).not.toContain('cloud_polish')
  })

  it('skips the managed server cleanup for a recording below the minimum duration', async () => {
    mockSettings({ 'server.aiSource': 'managed', 'aiMinDurationSec': 10 })
    setServerFinal({ asr_text: 'raw server transcript', llm_text: 'raw server transcript', asr_ms: 10, llm_ms: 0, duration_sec: 1 })

    const result = await reprocessViaServer(new ArrayBuffer(ONE_SECOND_RECORDING_BYTES), [], true, 'Be concise', null, 'en')

    expect(sentStartMessage()).toMatchObject({ disable_ai: true })
    expect(sentStartMessage()).not.toHaveProperty('system_prompt')
    expect(result).toMatchObject({
      llmText: 'raw server transcript',
      aiSource: 'none',
      aiStatus: 'skipped',
    })
    expect(result.aiProvider).toBeUndefined()
    expect(invokedCommands()).not.toContain('cloud_polish')
  })

  describe('ai.outcome evidence', () => {
    const outcomeRecords = () => getRuntimeEvents().filter((event) => event.message === 'ai.outcome')

    it.each([
      {
        name: 'llm_debug with a provider proves an applied call even when llm_ms is 0',
        aiEnabled: true,
        final: { llm_ms: 0, llm_debug: { provider: 'openai', model: 'm' } },
        expected: { aiSource: 'server', aiStatus: 'applied', aiProvider: 'server' },
        detail: { status: 'applied', attempted: true, basis: 'llm_debug', provider: 'openai' },
      },
      {
        name: 'llm_debug error is an attempted call that stays unavailable',
        aiEnabled: true,
        final: { llm_ms: 0, llm_debug: { error: 'upstream timeout' } },
        expected: { aiSource: 'server', aiStatus: 'unavailable', aiProvider: 'server' },
        detail: { status: 'unavailable', attempted: true, basis: 'llm_debug' },
      },
      {
        name: 'an empty llm_debug means the server never called its LLM',
        aiEnabled: true,
        final: { llm_ms: 0, llm_debug: {} },
        expected: { aiSource: 'server', aiStatus: 'unavailable', aiProvider: 'server' },
        detail: { status: 'unavailable', attempted: false, basis: 'llm_debug' },
      },
      {
        name: 'an older server without llm_debug falls back to a positive llm_ms',
        aiEnabled: true,
        final: { llm_ms: 42 },
        expected: { aiSource: 'server', aiStatus: 'applied', aiProvider: 'server' },
        detail: { status: 'applied', attempted: true, basis: 'llm_ms' },
      },
      {
        name: 'an older server without llm_debug and a zero llm_ms is unavailable',
        aiEnabled: true,
        final: { llm_ms: 0 },
        expected: { aiSource: 'server', aiStatus: 'unavailable', aiProvider: 'server' },
        detail: { status: 'unavailable', attempted: false, basis: 'llm_ms' },
      },
      {
        name: 'a disabled AI is skipped',
        aiEnabled: false,
        final: { llm_ms: 0, llm_debug: {} },
        expected: { aiSource: 'none', aiStatus: 'skipped', aiProvider: undefined },
        detail: { status: 'skipped', attempted: false, skipCause: 'ai_disabled' },
      },
      {
        name: 'an empty recognition is skipped',
        aiEnabled: true,
        final: { asr_text: '', llm_text: '', llm_ms: 0, llm_debug: {} },
        expected: { aiSource: 'none', aiStatus: 'skipped', aiProvider: undefined },
        detail: { status: 'skipped', attempted: false, skipCause: 'empty_asr' },
      },
    ])('records one outcome when $name', async ({ aiEnabled, final, expected, detail }) => {
      clearRuntimeEvents()
      mockSettings({ 'server.aiSource': 'managed' })
      setServerFinal({
        asr_text: 'raw server transcript',
        llm_text: 'cleaned server transcript',
        asr_ms: 10,
        duration_sec: 1,
        ...final,
      })

      const result = await reprocessViaServer(new ArrayBuffer(ONE_SECOND_RECORDING_BYTES), [], aiEnabled, 'Be concise', null, 'en')

      expect(result).toMatchObject(expected)
      expect(result).not.toHaveProperty('llmDebug')
      expect(outcomeRecords()).toHaveLength(1)
      expect(outcomeRecords()[0]).toMatchObject({ source: 'history', detail: expect.objectContaining(detail) })
    })

    it('records a recording below the minimum duration as a duration skip', async () => {
      clearRuntimeEvents()
      mockSettings({ 'server.aiSource': 'managed', 'aiMinDurationSec': 10 })

      await reprocessViaServer(new ArrayBuffer(ONE_SECOND_RECORDING_BYTES), [], true, 'Be concise', null, 'en')

      expect(outcomeRecords()).toHaveLength(1)
      expect(outcomeRecords()[0].detail).toMatchObject({ skipCause: 'below_min_duration', attempted: false })
    })

    it('never puts the recognized text or the server error text in the record', async () => {
      clearRuntimeEvents()
      mockSettings({ 'server.aiSource': 'managed' })
      setServerFinal({
        asr_text: 'raw server transcript',
        llm_text: 'cleaned server transcript',
        asr_ms: 10,
        llm_ms: 0,
        duration_sec: 1,
        llm_debug: { error: 'upstream said: secret-token', messages: [{ content: 'secret prompt' }] },
      })

      await reprocessViaServer(new ArrayBuffer(ONE_SECOND_RECORDING_BYTES), [], true, 'Be concise', null, 'en')

      const serialized = JSON.stringify(outcomeRecords())
      expect(serialized).not.toContain('raw server transcript')
      expect(serialized).not.toContain('cleaned server transcript')
      expect(serialized).not.toContain('secret')
    })
  })

  it('runs the client cleanup for a custom server source and keeps the server text as its input', async () => {
    mockSettings({
      'server.aiSource': 'custom',
      ...aiSettings('openai_compat', 'https://a.example/v1', 'key-a', 'model-a'),
    })

    const result = await reprocessViaServer(new ArrayBuffer(ONE_SECOND_RECORDING_BYTES), [], true, 'Be concise', null, 'en')

    expect(sentStartMessage()).toMatchObject({ disable_ai: true })
    expect(sentStartMessage()).not.toHaveProperty('system_prompt')
    expect(mocks.invoke).toHaveBeenCalledWith('cloud_polish', {
      request: expect.objectContaining({
        text: 'raw server transcript',
        system_prompt: 'Be concise',
        text_context: null,
      }),
    })
    expect(result).toMatchObject({
      llmText: 'cleaned by custom',
      llmMs: 7,
      aiSource: 'custom',
      aiStatus: 'applied',
      aiProvider: 'openai_compat',
      aiModel: 'model-a',
    })
  })

  it('keeps the server text and skips the client cleanup below the minimum duration for a custom source', async () => {
    mockSettings({
      'server.aiSource': 'custom',
      'aiMinDurationSec': 10,
      ...aiSettings('openai_compat', 'https://a.example/v1', 'key-a', 'model-a'),
    })

    const result = await reprocessViaServer(new ArrayBuffer(ONE_SECOND_RECORDING_BYTES), [], true, undefined, null, 'en')

    expect(sentStartMessage()).toMatchObject({ disable_ai: true })
    expect(invokedCommands()).not.toContain('cloud_polish')
    expect(result).toMatchObject({
      llmText: 'raw server transcript',
      aiSource: 'none',
      aiStatus: 'skipped',
    })
  })

  it('keeps the recognized server text when the custom cleanup request is rejected', async () => {
    mockSettings({
      'server.aiSource': 'custom',
      ...aiSettings('openai_compat', 'https://a.example/v1', 'key-a', 'model-a'),
    })
    mocks.invoke.mockRejectedValue(new Error('AI request failed'))

    const result = await reprocessViaServer(new ArrayBuffer(ONE_SECOND_RECORDING_BYTES), [], true, undefined, null, 'en')

    expect(invokedCommands()).toEqual(['cloud_polish'])
    expect(result).toMatchObject({
      llmText: 'raw server transcript',
      llmMs: 0,
      aiSource: 'custom',
      aiStatus: 'failed',
      aiProvider: 'openai_compat',
      aiModel: 'model-a',
    })
  })

  it('keeps the recognized server text when the custom cleanup exceeds the shared timeout', async () => {
    mockSettings({
      'server.aiSource': 'custom',
      ...aiSettings('openai_compat', 'https://a.example/v1', 'key-a', 'model-a'),
    })
    mocks.invoke.mockImplementation(() => new Promise(() => { /* the native request never settles */ }))

    vi.useFakeTimers()
    try {
      const pending = reprocessViaServer(new ArrayBuffer(ONE_SECOND_RECORDING_BYTES), [], true, undefined, null, 'en')
      await vi.advanceTimersByTimeAsync(8001)
      const result = await pending

      expect(invokedCommands()).toEqual(['cloud_polish'])
      expect(result).toMatchObject({
        asrText: 'raw server transcript',
        llmText: 'raw server transcript',
        llmMs: 0,
        aiSource: 'custom',
        aiStatus: 'failed',
        aiProvider: 'openai_compat',
        aiModel: 'model-a',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips all cleanup and keeps the server text when AI is disabled with a custom source', async () => {
    mockSettings({
      'server.aiSource': 'custom',
      ...aiSettings('openai_compat', 'https://a.example/v1', 'key-a', 'model-a'),
    })

    const result = await reprocessViaServer(new ArrayBuffer(ONE_SECOND_RECORDING_BYTES), [], false, 'Be concise', null, 'en')

    expect(sentStartMessage()).toMatchObject({ disable_ai: true })
    expect(invokedCommands()).not.toContain('cloud_polish')
    expect(result).toMatchObject({
      llmText: 'raw server transcript',
      aiSource: 'none',
      aiStatus: 'skipped',
    })
    expect(result.aiProvider).toBeUndefined()
  })

  it('treats an unknown stored server source as the managed route', async () => {
    mockSettings({ 'server.aiSource': 'something-else' })
    setServerFinal({
      asr_text: 'raw server transcript',
      llm_text: 'cleaned server transcript',
      asr_ms: 10,
      llm_ms: 42,
      duration_sec: 1,
    })

    const result = await reprocessViaServer(new ArrayBuffer(ONE_SECOND_RECORDING_BYTES), [], true, undefined, null, 'en')

    expect(sentStartMessage()).toMatchObject({ disable_ai: false })
    expect(invokedCommands()).not.toContain('cloud_polish')
    expect(result).toMatchObject({ llmText: 'cleaned server transcript', aiSource: 'server', aiStatus: 'applied' })
  })

  it('skips the client cleanup when the server recognized no text for a custom source', async () => {
    mockSettings({
      'server.aiSource': 'custom',
      ...aiSettings('openai_compat', 'https://a.example/v1', 'key-a', 'model-a'),
    })
    setServerFinal({ asr_text: '', llm_text: '', asr_ms: 10, llm_ms: 0, duration_sec: 1 })

    const result = await reprocessViaServer(new ArrayBuffer(ONE_SECOND_RECORDING_BYTES), [], true, undefined, null, 'en')

    expect(invokedCommands()).not.toContain('cloud_polish')
    expect(result).toMatchObject({
      llmText: '',
      aiSource: 'none',
      aiStatus: 'skipped',
    })
  })

  it('does not overwrite the runtime server AI source while reprocessing', async () => {
    setRuntimeServerAiSource('managed')
    try {
      mockSettings({
        'server.aiSource': 'custom',
        ...aiSettings('openai_compat', 'https://a.example/v1', 'key-a', 'model-a'),
      })

      await reprocessViaServer(new ArrayBuffer(ONE_SECOND_RECORDING_BYTES), [], true, undefined, null, 'en')

      expect(getRuntimeServerAiSource()).toBe('managed')
    } finally {
      setRuntimeServerAiSource('managed')
    }
  })
  it('keeps the recognized Qwen Omni text without a separate cleanup request', async () => {
    mockCloudProfile('qwen_omni_flash')
    mockSettings(aiSettings('openai_compat', 'https://a.example/v1', 'key-a', 'model-a'))
    mocks.invoke.mockResolvedValue({ text: 'raw transcript', elapsed_ms: 18 })

    const result = await reprocessViaCloudApi(new ArrayBuffer(ONE_SECOND_RECORDING_BYTES), [], true, undefined, 'en')

    expect(invokedCommands()).toEqual(['cloud_transcribe'])
    expect(result).toMatchObject({
      asrText: 'raw transcript',
      llmText: 'raw transcript',
      llmMs: 0,
      aiSource: 'none',
      aiStatus: 'skipped',
    })
    expect(result.aiProvider).toBeUndefined()
    expect(result.aiModel).toBeUndefined()
  })
})

describe('history rerun failure feedback', () => {
  const missingAudioRecord: HistoryRecord = {
    id: 'history-missing-audio',
    timestamp: Date.now(),
    asrText: 'previous words',
    llmText: 'previous words',
    asrMs: 10,
    llmMs: 0,
    durationSec: 1,
    charCount: 14,
    workMode: 'cloud_api',
    audioFilePath: 'C:\\recordings\\gone.wav',
  }

  beforeEach(() => {
    mocks.listHistory.mockReset().mockResolvedValue([missingAudioRecord])
    mocks.countHistory.mockReset().mockResolvedValue(1)
    mocks.listen.mockReset().mockResolvedValue(() => undefined)
    mocks.exportHistory.mockReset().mockResolvedValue({ canceled: true, filePath: null })
    vi.mocked(bridge.readAudioFile).mockReset().mockResolvedValue(null)
    clearRuntimeEvents()
  })

  it('tells the user the recording is gone instead of silently stopping', async () => {
    render(createElement(History))

    fireEvent.click(await screen.findByRole('button', { name: t('record.details') }))
    fireEvent.click(await screen.findByRole('button', { name: t('record.reprocess') }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(
      t('record.reprocessFailed', { reason: t('record.audioMissing') }),
    )
    expect(bridge.readAudioFile).toHaveBeenCalledWith(missingAudioRecord.audioFilePath)
  })
})
