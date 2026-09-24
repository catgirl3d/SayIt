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
})
