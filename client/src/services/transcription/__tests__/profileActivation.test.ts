import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  delayedWrites: new Map<string, Promise<void>>(),
  invoke: vi.fn(),
  polish: vi.fn(),
  addHistory: vi.fn(),
}))

vi.mock('@/services/store', () => ({
  getSetting: vi.fn(async (key: string, fallback: unknown) => harness.settings.get(key) ?? fallback),
  addHistory: (...args: unknown[]) => harness.addHistory(...args),
  deleteHistory: vi.fn(),
  getActivePresetId: vi.fn(),
  getPromptPresets: vi.fn(),
  recordStats: vi.fn(),
  setActivePresetId: vi.fn(),
  setSetting: vi.fn(async (key: string, value: unknown) => {
    const delay = harness.delayedWrites.get(key)
    if (delay) await delay
    harness.settings.set(key, structuredClone(value))
  }),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => harness.invoke(...args) }))
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(),
  listen: vi.fn(async () => () => {}),
}))
vi.mock('@/services/debugLog', () => ({ addRuntimeEvent: vi.fn() }))
vi.mock('@/services/transcription/clientAiPolish', () => ({
  polishWithClientAi: (...args: unknown[]) => harness.polish(...args),
}))

import { emptyAsrProfile } from '@/features/settings/asrProviderCatalog'
import {
  ASR_ACTIVE_PROFILE_KEY,
  loadActiveAsrProfile,
  saveAsrProfiles,
} from '@/features/settings/asrProfileStore'
import { switchProvider } from '@/services/transcription'
import { CloudAPIProvider } from '../CloudAPIProvider'
import { RecorderOrchestrator } from '@/services/recorder/RecorderOrchestrator'

beforeEach(() => {
  harness.settings.clear()
  harness.delayedWrites.clear()
  harness.invoke.mockReset()
  harness.polish.mockReset()
  harness.addHistory.mockReset()
  harness.addHistory.mockResolvedValue(undefined)
  harness.invoke.mockImplementation(async (command: string) => (
    command === 'cloud_transcribe' ? { text: 'recognized', elapsed_ms: 12 } : undefined
  ))
  harness.polish.mockImplementation(async ({ asrText }: { asrText: string }) => ({
    llmText: asrText,
    llmMs: 0,
    aiSource: 'none',
    aiStatus: 'skipped',
  }))
})

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('ASR profile activation and recording ordering', () => {
  it('uses the profile whose activation was submitted before recording start', async () => {
    const first = {
      ...emptyAsrProfile('openai_transcribe'),
      id: 'openai-account-a',
      apiKey: 'key-account-a',
      model: 'gpt-transcribe',
    }
    const second = {
      ...emptyAsrProfile('openai_transcribe'),
      id: 'openai-account-b',
      apiKey: 'key-account-b',
      model: 'whisper-1',
    }
    await saveAsrProfiles({ profiles: [first, second], activeId: first.id })

    const activationGate = deferred<void>()
    harness.delayedWrites.set(ASR_ACTIVE_PROFILE_KEY, activationGate.promise)
    const activation = saveAsrProfiles({ profiles: [first, second], activeId: second.id })
    const provider = new CloudAPIProvider()
    let recordingDone = false
    let resolveRecordingDone!: () => void
    const done = new Promise<void>((resolve) => { resolveRecordingDone = resolve })
    const errors: string[] = []
    await provider.connect({
      onError: (error) => errors.push(error),
      onDone: () => {
        recordingDone = true
        resolveRecordingDone()
      },
    })

    try {
      expect(provider.start({ runId: 1, language: 'uk' })).toBe(true)
      provider.sendAudio(new ArrayBuffer(16000))
      expect(provider.stop()).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(recordingDone).toBe(false)
    } finally {
      activationGate.resolve()
    }

    await activation
    await done

    const requests = harness.invoke.mock.calls
      .filter(([command]) => command === 'cloud_transcribe')
      .map(([, args]) => (args as { request: { asr_config: Record<string, unknown> } }).request.asr_config)
    expect(requests).toEqual([{
      provider: 'openai_transcribe',
      api_key: 'key-account-b',
      app_id: '',
      extra: { model: 'whisper-1', language: 'uk' },
    }])
    expect(errors).toEqual([])
    await expect(loadActiveAsrProfile()).resolves.toMatchObject({ id: second.id, apiKey: 'key-account-b' })
  })

  it('persists empty onASR metadata before onFinal after switching profiles, without relabeling legacy results', async () => {
    const first = {
      ...emptyAsrProfile('openai_transcribe'),
      id: 'openai-account-a',
      apiKey: 'key-account-a',
      model: 'gpt-transcribe',
    }
    const second = {
      ...emptyAsrProfile('gemini_transcribe'),
      id: 'gemini-account-b',
      apiKey: 'key-account-b',
    }
    const legacy = {
      ...emptyAsrProfile('groq_whisper'),
      id: 'groq-account-c',
      apiKey: 'key-account-c',
    }
    const profiles = [first, second, legacy]
    await saveAsrProfiles({ profiles, activeId: first.id })

    const transcriptions = [
      deferred<{ text: string; elapsed_ms: number }>(),
      deferred<{ text: string; elapsed_ms: number }>(),
    ]
    const requestStarted = [deferred<void>(), deferred<void>()]
    const providerDone = [deferred<void>(), deferred<void>()]
    const historySaved = [deferred<Record<string, unknown>>(), deferred<Record<string, unknown>>()]
    let requestIndex = 0
    let doneIndex = 0
    let historyIndex = 0
    harness.invoke.mockImplementation((command: string) => {
      if (command === 'cloud_transcribe') {
        const index = requestIndex++
        requestStarted[index].resolve()
        return transcriptions[index].promise
      }
      return undefined
    })
    harness.addHistory.mockImplementation(async (record: Record<string, unknown>) => {
      historySaved[historyIndex++].resolve(record)
    })

    const provider = await switchProvider('cloud_api')
    const recorder = new RecorderOrchestrator()
    const overlay = {
      showNoSpeech: vi.fn(),
      stopListeningTicker: vi.fn(),
      resetWarnings: vi.fn(),
      resetStreamingText: vi.fn(),
      clearFallbackHideTimer: vi.fn(),
      hide: vi.fn(),
    }
    Reflect.set(recorder, 'overlayService', overlay)
    const createCallbacks = Reflect.get(RecorderOrchestrator.prototype, 'buildProviderCallbacks') as (
      this: RecorderOrchestrator,
    ) => Parameters<typeof provider.connect>[0]
    const callbacks = createCallbacks.call(recorder)
    const callbackOrder: string[] = []
    const asrResults: Array<{ text: string; asrEngine?: string; asrModel?: string }> = []
    const finalResults: Array<{ asrText: string; asrEngine?: string; asrModel?: string }> = []
    const originalOnASR = callbacks.onASR
    const originalOnFinal = callbacks.onFinal
    const originalOnDone = callbacks.onDone
    callbacks.onASR = (result) => {
      callbackOrder.push('onASR')
      asrResults.push(result)
      originalOnASR?.(result)
    }
    callbacks.onFinal = (result) => {
      callbackOrder.push('onFinal')
      finalResults.push(result)
      originalOnFinal?.(result)
    }
    callbacks.onDone = () => {
      callbackOrder.push('onDone')
      originalOnDone?.()
      providerDone[doneIndex++].resolve()
    }
    await provider.connect(callbacks)

    const prepareRun = (runId: number) => {
      Reflect.set(recorder, 'state', 'processing')
      Reflect.set(recorder, 'activeRunId', runId)
      Reflect.set(recorder, 'audioSentSamples', 8000)
      Reflect.set(recorder, 'wallTimeAtStopSec', 0.5)
    }

    prepareRun(2)
    expect(provider.start({ runId: 2, language: 'uk' })).toBe(true)
    provider.sendAudio(new ArrayBuffer(16000))
    expect(provider.stop()).toBe(true)
    await requestStarted[0].promise

    await saveAsrProfiles({ profiles, activeId: second.id })
    expect(harness.settings.get('cloudAsr.provider')).toBe('gemini_transcribe')
    transcriptions[0].resolve({ text: '', elapsed_ms: 12 })
    await providerDone[0].promise
    const firstHistory = await historySaved[0].promise
    await vi.waitFor(() => expect(recorder.getState()).toBe('idle'))

    expect(callbackOrder.slice(0, 3)).toEqual(['onASR', 'onFinal', 'onDone'])
    expect(firstHistory).toMatchObject({ asrProvider: 'gpt-transcribe', isEmpty: true })
    expect(harness.addHistory).toHaveBeenCalledTimes(1)
    expect(asrResults[0]).toMatchObject({ text: '', asrEngine: 'openai_transcribe', asrModel: 'gpt-transcribe' })
    expect(finalResults[0]).toMatchObject({ asrText: '', asrEngine: 'openai_transcribe', asrModel: 'gpt-transcribe' })

    await saveAsrProfiles({ profiles, activeId: legacy.id })
    prepareRun(3)
    expect(provider.start({ runId: 3, language: 'uk' })).toBe(true)
    provider.sendAudio(new ArrayBuffer(16000))
    expect(provider.stop()).toBe(true)
    await requestStarted[1].promise
    transcriptions[1].resolve({ text: '', elapsed_ms: 9 })
    await providerDone[1].promise
    const legacyHistory = await historySaved[1].promise
    await vi.waitFor(() => expect(recorder.getState()).toBe('idle'))

    expect(callbackOrder.slice(3, 6)).toEqual(['onASR', 'onFinal', 'onDone'])
    expect(legacyHistory).toMatchObject({ asrText: '', isEmpty: true })
    expect(legacyHistory).not.toHaveProperty('asrProvider')
    expect(harness.addHistory).toHaveBeenCalledTimes(2)
  })

  it('records the captured Qwen 3.8 model once for empty and completed Omni requests', async () => {
    const qwen38 = {
      ...emptyAsrProfile('qwen_omni_38_realtime'),
      id: 'qwen38-account-a',
      apiKey: 'qwen38-key',
      omniPrompt: 'Transcribe faithfully.',
    }
    const qwen35 = {
      ...emptyAsrProfile('qwen_omni_35_flash'),
      id: 'qwen35-account-b',
      apiKey: 'qwen35-key',
    }
    const profiles = [qwen38, qwen35]
    await saveAsrProfiles({ profiles, activeId: qwen38.id })

    const transcriptions = [
      deferred<{ text: string; elapsed_ms: number }>(),
      deferred<{ text: string; elapsed_ms: number }>(),
    ]
    const requestStarted = [deferred<void>(), deferred<void>()]
    const providerDone = [deferred<void>(), deferred<void>()]
    const historySaved = [deferred<Record<string, unknown>>(), deferred<Record<string, unknown>>()]
    let requestIndex = 0
    let doneIndex = 0
    let historyIndex = 0
    harness.invoke.mockImplementation((command: string) => {
      if (command === 'cloud_transcribe') {
        const index = requestIndex++
        requestStarted[index].resolve()
        return transcriptions[index].promise
      }
      return undefined
    })
    harness.addHistory.mockImplementation(async (record: Record<string, unknown>) => {
      historySaved[historyIndex++].resolve(record)
    })

    const provider = await switchProvider('cloud_api')
    const recorder = new RecorderOrchestrator()
    const overlay = {
      showNoSpeech: vi.fn(),
      showFallback: vi.fn(),
      disableEscapeAction: vi.fn(async () => {}),
      stopListeningTicker: vi.fn(),
      resetWarnings: vi.fn(),
      resetStreamingText: vi.fn(),
      clearFallbackHideTimer: vi.fn(),
      hide: vi.fn(),
    }
    Reflect.set(recorder, 'overlayService', overlay)
    Reflect.set(recorder, 'pasteService', {
      getProbeResult: async () => ({ editable: true }),
      pasteText: async () => ({ ok: true, strategy: 'test', detail: '', attempts: 1 }),
    })
    Reflect.set(recorder, 'updatePersonalizationFromFinal', async () => {})
    const createCallbacks = Reflect.get(RecorderOrchestrator.prototype, 'buildProviderCallbacks') as (
      this: RecorderOrchestrator,
    ) => Parameters<typeof provider.connect>[0]
    const callbacks = createCallbacks.call(recorder)
    const callbackOrder: string[] = []
    const asrResults: Array<{ text: string; asrEngine?: string; asrModel?: string }> = []
    const finalResults: Array<{ asrText: string; asrEngine?: string; asrModel?: string }> = []
    const originalOnASR = callbacks.onASR
    const originalOnFinal = callbacks.onFinal
    const originalOnDone = callbacks.onDone
    callbacks.onASR = (result) => {
      callbackOrder.push('onASR')
      asrResults.push(result)
      originalOnASR?.(result)
    }
    callbacks.onFinal = (result) => {
      callbackOrder.push('onFinal')
      finalResults.push(result)
      originalOnFinal?.(result)
    }
    callbacks.onDone = () => {
      callbackOrder.push('onDone')
      originalOnDone?.()
      providerDone[doneIndex++].resolve()
    }
    await provider.connect(callbacks)

    const prepareRun = (runId: number) => {
      Reflect.set(recorder, 'state', 'processing')
      Reflect.set(recorder, 'activeRunId', runId)
      Reflect.set(recorder, 'audioSentSamples', 8000)
      Reflect.set(recorder, 'wallTimeAtStopSec', 0.5)
    }
    const startRun = (runId: number) => {
      prepareRun(runId)
      expect(provider.start({ runId, language: 'uk' })).toBe(true)
      provider.sendAudio(new ArrayBuffer(16000))
      expect(provider.stop()).toBe(true)
    }

    startRun(4)
    await requestStarted[0].promise
    const firstRequest = harness.invoke.mock.calls.find(([command]) => command === 'cloud_transcribe')
    expect((firstRequest?.[1] as { request: { asr_config: Record<string, unknown> } }).request.asr_config).toEqual({
      provider: 'qwen_omni',
      api_key: 'qwen38-key',
      app_id: '',
      extra: { model: 'qwen3.8-omni-flash-realtime', instructions: 'Transcribe faithfully.' },
    })
    await saveAsrProfiles({ profiles, activeId: qwen35.id })
    transcriptions[0].resolve({ text: '', elapsed_ms: 12 })
    await providerDone[0].promise
    const emptyHistory = await historySaved[0].promise
    await vi.waitFor(() => expect(recorder.getState()).toBe('idle'))

    expect(callbackOrder.slice(0, 3)).toEqual(['onASR', 'onFinal', 'onDone'])
    expect(asrResults[0]).toMatchObject({
      text: '',
      asrEngine: 'qwen_omni',
      asrModel: 'qwen3.8-omni-flash-realtime',
    })
    expect(finalResults[0]).toMatchObject({
      asrText: '',
      asrEngine: 'qwen_omni',
      asrModel: 'qwen3.8-omni-flash-realtime',
    })
    expect(emptyHistory).toMatchObject({ asrProvider: 'qwen3.8-omni-flash-realtime', isEmpty: true })
    expect(harness.addHistory).toHaveBeenCalledTimes(1)
    expect(harness.polish).not.toHaveBeenCalled()

    await saveAsrProfiles({ profiles, activeId: qwen38.id })
    startRun(5)
    await requestStarted[1].promise
    await saveAsrProfiles({ profiles, activeId: qwen35.id })
    transcriptions[1].resolve({ text: 'recognized with Qwen 3.8', elapsed_ms: 15 })
    await providerDone[1].promise
    const completedHistory = await historySaved[1].promise
    await vi.waitFor(() => expect(recorder.getState()).toBe('idle'))

    expect(completedHistory).toMatchObject({ asrText: 'recognized with Qwen 3.8', asrProvider: 'qwen3.8-omni-flash-realtime' })
    expect(harness.addHistory).toHaveBeenCalledTimes(2)
    expect(harness.polish).not.toHaveBeenCalled()
  })

  it('keeps a completed fixed-model recording bound to the profile that started it', async () => {
    const qwen = {
      ...emptyAsrProfile('qwen'),
      id: 'qwen-account-a',
      apiKey: 'qwen-key',
    }
    const groq = {
      ...emptyAsrProfile('groq_whisper'),
      id: 'groq-account-b',
      apiKey: 'groq-key',
    }
    const qwen35 = {
      ...emptyAsrProfile('qwen_omni_35_flash'),
      id: 'qwen35-account-c',
      apiKey: 'qwen35-key',
    }
    const profiles = [qwen, groq, qwen35]
    await saveAsrProfiles({ profiles, activeId: qwen.id })

    const transcriptions = [
      deferred<{ text: string; elapsed_ms: number }>(),
      deferred<{ text: string; elapsed_ms: number }>(),
    ]
    const requestStarted = [deferred<void>(), deferred<void>()]
    const providerDone = [deferred<void>(), deferred<void>()]
    const historySaved = [deferred<Record<string, unknown>>(), deferred<Record<string, unknown>>()]
    let requestIndex = 0
    let doneIndex = 0
    let historyIndex = 0
    harness.invoke.mockImplementation((command: string) => {
      if (command === 'cloud_transcribe') {
        const index = requestIndex++
        requestStarted[index].resolve()
        return transcriptions[index].promise
      }
      return undefined
    })
    harness.addHistory.mockImplementation(async (record: Record<string, unknown>) => {
      historySaved[historyIndex++].resolve(record)
    })

    const provider = await switchProvider('cloud_api')
    const recorder = new RecorderOrchestrator()
    const overlay = {
      showNoSpeech: vi.fn(),
      showFallback: vi.fn(),
      disableEscapeAction: vi.fn(async () => {}),
      stopListeningTicker: vi.fn(),
      resetWarnings: vi.fn(),
      resetStreamingText: vi.fn(),
      clearFallbackHideTimer: vi.fn(),
      hide: vi.fn(),
    }
    Reflect.set(recorder, 'overlayService', overlay)
    Reflect.set(recorder, 'pasteService', {
      getProbeResult: async () => ({ editable: true }),
      pasteText: async () => ({ ok: true, strategy: 'test', detail: '', attempts: 1 }),
    })
    Reflect.set(recorder, 'updatePersonalizationFromFinal', async () => {})
    const createCallbacks = Reflect.get(RecorderOrchestrator.prototype, 'buildProviderCallbacks') as (
      this: RecorderOrchestrator,
    ) => Parameters<typeof provider.connect>[0]
    const callbacks = createCallbacks.call(recorder)
    const originalOnDone = callbacks.onDone
    callbacks.onDone = () => {
      originalOnDone?.()
      providerDone[doneIndex++].resolve()
    }
    await provider.connect(callbacks)

    const prepareRun = (runId: number) => {
      Reflect.set(recorder, 'state', 'processing')
      Reflect.set(recorder, 'activeRunId', runId)
      Reflect.set(recorder, 'audioSentSamples', 8000)
      Reflect.set(recorder, 'wallTimeAtStopSec', 0.5)
    }
    const startRun = (runId: number) => {
      prepareRun(runId)
      expect(provider.start({ runId, language: 'uk' })).toBe(true)
      provider.sendAudio(new ArrayBuffer(16000))
      expect(provider.stop()).toBe(true)
    }

    startRun(6)
    await requestStarted[0].promise
    await saveAsrProfiles({ profiles, activeId: groq.id })
    transcriptions[0].resolve({ text: 'recognized with Qwen', elapsed_ms: 12 })
    await providerDone[0].promise
    const qwenHistory = await historySaved[0].promise
    await vi.waitFor(() => expect(recorder.getState()).toBe('idle'))

    expect(qwenHistory).toMatchObject({ asrText: 'recognized with Qwen', asrProvider: 'qwen3-asr-flash' })

    await saveAsrProfiles({ profiles, activeId: qwen35.id })
    startRun(7)
    await requestStarted[1].promise
    await saveAsrProfiles({ profiles, activeId: qwen.id })
    transcriptions[1].resolve({ text: 'recognized with Omni', elapsed_ms: 15 })
    await providerDone[1].promise
    const omniHistory = await historySaved[1].promise
    await vi.waitFor(() => expect(recorder.getState()).toBe('idle'))

    expect(omniHistory).toMatchObject({ asrText: 'recognized with Omni', asrProvider: 'qwen3.5-omni-flash-realtime' })
    expect(harness.addHistory).toHaveBeenCalledTimes(2)
  })

  it('still labels a completed fixed-model recording when the profile never changed', async () => {
    const qwen = {
      ...emptyAsrProfile('qwen'),
      id: 'qwen-guard',
      apiKey: 'qwen-key',
    }
    await saveAsrProfiles({ profiles: [qwen], activeId: qwen.id })

    const transcription = deferred<{ text: string; elapsed_ms: number }>()
    const requestStarted = deferred<void>()
    const historySaved = deferred<Record<string, unknown>>()
    harness.invoke.mockImplementation((command: string) => {
      if (command === 'cloud_transcribe') {
        requestStarted.resolve()
        return transcription.promise
      }
      return undefined
    })
    harness.addHistory.mockImplementation(async (record: Record<string, unknown>) => historySaved.resolve(record))

    const provider = await switchProvider('cloud_api')
    const recorder = new RecorderOrchestrator()
    Reflect.set(recorder, 'overlayService', {
      showNoSpeech: vi.fn(),
      showFallback: vi.fn(),
      disableEscapeAction: vi.fn(async () => {}),
      stopListeningTicker: vi.fn(),
      resetWarnings: vi.fn(),
      resetStreamingText: vi.fn(),
      clearFallbackHideTimer: vi.fn(),
      hide: vi.fn(),
    })
    Reflect.set(recorder, 'pasteService', {
      getProbeResult: async () => ({ editable: true }),
      pasteText: async () => ({ ok: true, strategy: 'test', detail: '', attempts: 1 }),
    })
    Reflect.set(recorder, 'updatePersonalizationFromFinal', async () => {})
    const createCallbacks = Reflect.get(RecorderOrchestrator.prototype, 'buildProviderCallbacks') as (
      this: RecorderOrchestrator,
    ) => Parameters<typeof provider.connect>[0]
    await provider.connect(createCallbacks.call(recorder))
    Reflect.set(recorder, 'state', 'processing')
    Reflect.set(recorder, 'activeRunId', 8)
    Reflect.set(recorder, 'audioSentSamples', 8000)
    Reflect.set(recorder, 'wallTimeAtStopSec', 0.5)

    expect(provider.start({ runId: 8, language: 'uk' })).toBe(true)
    provider.sendAudio(new ArrayBuffer(16000))
    expect(provider.stop()).toBe(true)
    await requestStarted.promise
    transcription.resolve({ text: 'recognized without switching', elapsed_ms: 11 })

    const record = await historySaved.promise
    await vi.waitFor(() => expect(recorder.getState()).toBe('idle'))

    expect(record).toMatchObject({ asrProvider: 'qwen3-asr-flash' })
  })

  it('persists the custom provider and model for empty history and final-result metadata', async () => {
    const custom = {
      ...emptyAsrProfile('openai_compat'),
      id: 'custom-profile',
      baseUrl: 'http://localhost:8090/v1',
      apiKey: '',
      model: 'local-whisper',
      protocol: 'transcriptions' as const,
    }
    await saveAsrProfiles({ profiles: [custom], activeId: custom.id })
    const transcription = deferred<{ text: string; elapsed_ms: number }>()
    const requestStarted = deferred<void>()
    const historySaved = deferred<Record<string, unknown>>()
    harness.invoke.mockImplementation((command: string) => {
      if (command === 'cloud_transcribe') {
        requestStarted.resolve()
        return transcription.promise
      }
      return undefined
    })
    harness.addHistory.mockImplementation(async (record: Record<string, unknown>) => historySaved.resolve(record))

    const provider = await switchProvider('cloud_api')
    const recorder = new RecorderOrchestrator()
    Reflect.set(recorder, 'overlayService', {
      showNoSpeech: vi.fn(),
      stopListeningTicker: vi.fn(),
      resetWarnings: vi.fn(),
      resetStreamingText: vi.fn(),
      clearFallbackHideTimer: vi.fn(),
      hide: vi.fn(),
    })
    const createCallbacks = Reflect.get(RecorderOrchestrator.prototype, 'buildProviderCallbacks') as (
      this: RecorderOrchestrator,
    ) => Parameters<typeof provider.connect>[0]
    await provider.connect(createCallbacks.call(recorder))
    Reflect.set(recorder, 'state', 'processing')
    Reflect.set(recorder, 'activeRunId', 41)
    Reflect.set(recorder, 'audioSentSamples', 8000)
    Reflect.set(recorder, 'wallTimeAtStopSec', 0.5)

    expect(provider.start({ runId: 41, language: 'uk' })).toBe(true)
    provider.sendAudio(new ArrayBuffer(16000))
    expect(provider.stop()).toBe(true)
    await requestStarted.promise
    transcription.resolve({ text: '', elapsed_ms: 8 })
    const record = await historySaved.promise

    expect(record).toMatchObject({
      asrProvider: 'openai_compat:local-whisper',
      isEmpty: true,
      failReasonCode: 'no_transcript',
    })
    const buildProviderMetadata = Reflect.get(RecorderOrchestrator.prototype, 'buildProviderMetadata') as (
      this: RecorderOrchestrator,
      result: { asrEngine: string; asrModel: string },
    ) => Promise<{ asrProvider?: string }>
    await expect(buildProviderMetadata.call(recorder, {
      asrEngine: 'openai_compat',
      asrModel: 'local-whisper',
    })).resolves.toMatchObject({ asrProvider: 'openai_compat:local-whisper' })
  })

  it('persists the OpenRouter insufficient-balance category for eligible ASR failures', async () => {
    harness.settings.set('historyEnabled', true)
    harness.settings.set('audioRetentionEnabled', false)
    const historySaved = deferred<Record<string, unknown>>()
    harness.addHistory.mockImplementation(async (record: Record<string, unknown>) => {
      historySaved.resolve(record)
    })

    const recorder = new RecorderOrchestrator()
    Reflect.set(recorder, 'overlayService', {
      disableEscapeAction: vi.fn(async () => {}),
      stopListeningTicker: vi.fn(),
      resetWarnings: vi.fn(),
      resetStreamingText: vi.fn(),
      clearFallbackHideTimer: vi.fn(),
      hide: vi.fn(),
    })
    Reflect.set(recorder, 'state', 'processing')
    Reflect.set(recorder, 'activeRunId', 42)
    Reflect.set(recorder, 'audioSentSamples', 8000)
    Reflect.set(recorder, 'recordedChunks', [new ArrayBuffer(16)])

    const createCallbacks = Reflect.get(RecorderOrchestrator.prototype, 'buildProviderCallbacks') as (
      this: RecorderOrchestrator,
    ) => { onError?: (message: string) => void }
    const callbacks = createCallbacks.call(recorder)
    callbacks.onError?.(
      'sayit_error:provider_insufficient_balance:OpenRouter transcription request returned HTTP status 402',
    )

    const record = await historySaved.promise
    await vi.waitFor(() => expect(recorder.getState()).toBe('idle'))

    expect(harness.addHistory).toHaveBeenCalledTimes(1)
    expect(record).toMatchObject({
      isEmpty: true,
      failReason: 'OpenRouter transcription request returned HTTP status 402',
      failReasonCode: 'provider_insufficient_balance',
    })
  })
})
