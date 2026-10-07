import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  settings: new Map<string, unknown>(),
  captured: [] as Uint8Array[],
  transcribeArgs: [] as Array<Record<string, unknown>>,
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => native.invoke(...args) }))
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async (name: string, listener: (event: { payload: unknown }) => void) => {
    native.listeners.set(name, listener)
    return () => native.listeners.delete(name)
  }),
}))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn() }))
vi.mock('../debugLog', async (importOriginal) => ({
  ...await importOriginal<typeof import('../debugLog')>(),
  addRuntimeEvent: vi.fn(),
}))

import { SystemAudioSession } from '../systemAudio'
import { LocalProvider } from '../transcription/LocalProvider'
import { CloudAPIProvider } from '../transcription/CloudAPIProvider'
import { ServerProvider } from '../transcription/ServerProvider'
import type { StartOptions, TranscriptionCallbacks, TranscriptionProvider } from '../transcription/types'
import type { SubtitleOverlayPayload } from '../recorder/types'
import { uint8ArrayToBase64 } from '@/lib/encoding'
import { describeProviderError } from '@/lib/errorMessages'
import { clearPipelineTrace, getPipelineSnapshot, setPipelineDebugEnabled } from '../pipelineTrace'

type OverlayCall =
  | { method: 'present'; payload: SubtitleOverlayPayload }
  | { method: 'update'; payload: SubtitleOverlayPayload }
  | { method: 'hide' }

let overlayCalls: OverlayCall[]

function createOverlayPort() {
  return {
    present: vi.fn(async (payload: SubtitleOverlayPayload) => {
      overlayCalls.push({ method: 'present', payload })
      return 1
    }),
    update: vi.fn(async (payload: SubtitleOverlayPayload) => {
      overlayCalls.push({ method: 'update', payload })
    }),
    hide: vi.fn(async () => {
      overlayCalls.push({ method: 'hide' })
    }),
  }
}

function createTestProvider(
  onConnect: (callbacks: TranscriptionCallbacks) => void,
  onDisconnect: () => void = () => {},
): TranscriptionProvider {
  return {
    mode: 'local',
    connect: async (callbacks) => { onConnect(callbacks) },
    start: () => true,
    cancel: () => {},
    sendAudio: () => {},
    stop: () => true,
    disconnect: onDisconnect,
    isReady: () => true,
  }
}

let overlay: ReturnType<typeof createOverlayPort>

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function settle() {
  for (let index = 0; index < 30; index++) await Promise.resolve()
}

let session: SystemAudioSession
let leased = false

function enablePipelineDebug() {
  clearPipelineTrace()
  setPipelineDebugEnabled(true)
  return { getPipelineSnapshot }
}

function frames(count: number, probability: number, value = 1, sessionId?: number, discontinuity = false) {
  const started = [...native.invoke.mock.calls].reverse().find(([name]) => name === 'start_system_audio_capture')
  const id = sessionId ?? (started?.[1] as { sessionId: number } | undefined)?.sessionId
  const data = new Int16Array(512).fill(value)
  for (let index = 0; index < count; index++) {
    native.listeners.get('system-audio-frame')?.({ payload: {
      sessionId: id,
      audioB64: uint8ArrayToBase64(new Uint8Array(data.buffer)),
      speechProbability: probability,
      discontinuity: discontinuity && index === 0,
    } })
  }
}

function numberRecognizedSpeech() {
  let heard = 0
  const original = native.invoke.getMockImplementation()!
  native.invoke.mockImplementation(async (name, args) => {
    const result = await original(name, args)
    return name === 'local_transcribe' ? { ...result, text: `Speech ${++heard}` } : result
  })
}

function polishRequests() {
  return native.invoke.mock.calls.filter(([name]) => name === 'cloud_polish').map(([, args]) => args.request)
}

function emitPolishDelta(requestId: unknown, text: string) {
  native.listeners.get('cloud-polish-delta')?.({ payload: { requestId, text } })
}

function speak() {
  frames(20, 0.9)
  frames(15, 0)
}

beforeEach(() => {
  vi.useFakeTimers()
  setPipelineDebugEnabled(false)
  clearPipelineTrace()
  native.settings.clear()
  native.settings.set('cloudAi.provider', 'ollama')
  native.settings.set('cloudAi.apiUrl', 'http://127.0.0.1:11434')
  native.settings.set('cloudAi.model', 'translator')
  native.settings.set('aiEnabled', false)
  native.settings.set('aiMinDurationSec', 10)
  native.settings.set('activePresetId', 'intent')
  native.settings.set('speechInput.language', 'en')
  native.listeners.clear()
  native.captured.length = 0
  native.transcribeArgs.length = 0
  overlayCalls = []
  overlay = createOverlayPort()
  leased = false
  native.invoke.mockReset().mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === 'store_get') return native.settings.get(args.key as string) ?? null
    if (name === 'store_set') { native.settings.set(args.key as string, args.value); return }
    if (name === 'list_downloaded_models') return [{ id: 'sensevoice-small-gguf', complete: true }]
    if (name === 'local_transcribe') {
      native.transcribeArgs.push(args)
      native.captured.push(Uint8Array.from(atob(args.audioB64 as string), (char) => char.charCodeAt(0)))
      return { text: 'Original speech', elapsed_ms: 5 }
    }
    if (name === 'cloud_polish') return { text: 'Translated speech', elapsed_ms: 5 }
    if (name === 'cloud_transcribe') return { text: 'Original speech', elapsed_ms: 5 }
    return 1
  })
  session = new SystemAudioSession({
    getProvider: () => new LocalProvider(),
    acquire: async () => { if (leased) throw new Error('Recorder busy'); leased = true },
    release: async () => { leased = false },
    overlay,
  })
})

afterEach(async () => {
  await session.stop()
  setPipelineDebugEnabled(false)
  clearPipelineTrace()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('system audio subtitle session', () => {
  it('runs recognition-only without a translation preset and publishes raw ASR before the run finishes', async () => {
    const trace = enablePipelineDebug()
    const presetLookup = vi.spyOn(await import('../store'), 'getPromptPresets').mockResolvedValue([])
    const pendingTranscription = deferred<{ text: string; elapsed_ms: number }>()
    const originalInvoke = native.invoke.getMockImplementation()!
    native.invoke.mockImplementation((name, args) => name === 'local_transcribe'
      ? pendingTranscription.promise : originalInvoke(name, args))
    const provider = new LocalProvider()
    const providerStart = vi.spyOn(provider, 'start')
    session = new SystemAudioSession({
      getProvider: () => provider,
      acquire: async () => { leased = true },
      release: async () => { leased = false },
      overlay,
    })

    await session.start({ deviceId: '', targetLanguage: 'missing-preset', asrOnly: true })
    expect(session.getSnapshot().state).toBe('listening')
    expect(presetLookup).not.toHaveBeenCalled()
    frames(20, 0.9)
    frames(15, 0)
    await settle()
    expect(native.invoke.mock.calls.filter(([name]) => name === 'local_transcribe')).toHaveLength(1)

    pendingTranscription.resolve({ text: 'Original speech', elapsed_ms: 5 })
    await Promise.resolve()

    expect(session.getSnapshot()).toMatchObject({ state: 'listening', caption: 'Original speech', error: '' })
    expect(trace.getPipelineSnapshot().activity.phase).toBe('listening')
    expect(trace.getPipelineSnapshot().runs).toHaveLength(0)

    await settle()

    expect(providerStart).toHaveBeenCalledWith(expect.objectContaining({
      systemPrompt: '',
      disableAi: true,
      aiMinDurationSec: 0,
      requireTranslation: false,
    }))
    expect(native.invoke.mock.calls.some(([name]) => name === 'cloud_polish')).toBe(false)
    expect(overlayCalls.some((call) => call.method === 'update' && call.payload.subtitleText === 'Original speech')).toBe(true)
    expect(trace.getPipelineSnapshot().runs).toMatchObject([{
      status: 'ok',
      asrOnly: true,
      asrMs: 5,
      llmMs: 0,
      asrChars: 15,
      captionChars: 15,
    }])
  })

  it('records empty recognition-only runs without showing a caption', async () => {
    const trace = enablePipelineDebug()
    const originalInvoke = native.invoke.getMockImplementation()!
    native.invoke.mockImplementation((name, args) => name === 'local_transcribe'
      ? Promise.resolve({ text: '', elapsed_ms: 5 }) : originalInvoke(name, args))
    session = new SystemAudioSession({
      getProvider: () => new LocalProvider(),
      acquire: async () => { leased = true },
      release: async () => { leased = false },
      overlay,
    })

    await session.start({ deviceId: '', targetLanguage: 'missing-preset', asrOnly: true })
    frames(20, 0.9)
    frames(15, 0)
    await settle()

    expect(session.getSnapshot()).toMatchObject({ state: 'listening', caption: '', error: '' })
    expect(trace.getPipelineSnapshot().runs).toMatchObject([{ status: 'empty', asrOnly: true }])
  })

  it('does not require server translation readiness in recognition-only mode', async () => {
    const provider: TranscriptionProvider = {
      mode: 'server',
      connect: async (callbacks) => { callbacks.onReady?.({ asr: true, llm: false }) },
      start: () => true,
      cancel: () => {},
      sendAudio: () => {},
      stop: () => true,
      disconnect: () => {},
      isReady: () => true,
    }
    session = new SystemAudioSession({
      getProvider: () => provider,
      acquire: async () => { leased = true },
      release: async () => { leased = false },
      overlay,
    })

    await session.start({ deviceId: '', targetLanguage: 'ru', asrOnly: true })

    expect(session.getSnapshot().state).toBe('listening')
  })

  it('runs client-AI modes through an ASR-only provider run and translates with the client AI', async () => {
    let callbacks: TranscriptionCallbacks | undefined
    let startOptions: StartOptions | undefined
    const provider = createTestProvider((value) => { callbacks = value })
    provider.start = (options) => { startOptions = options; return true }
    session = new SystemAudioSession({
      getProvider: () => provider,
      acquire: async () => { leased = true },
      release: async () => { leased = false },
      overlay,
    })

    await session.start({ deviceId: '', targetLanguage: 'ru' })
    frames(20, 0.9)
    frames(15, 0)
    callbacks?.onASR?.({ text: 'Original speech', asrMs: 5, durationSec: 0.64 })
    callbacks?.onFinal?.({
      asrText: 'Original speech',
      llmText: '',
      asrMs: 5,
      llmMs: 0,
      durationSec: 0.64,
      aiStatus: 'skipped',
    })
    callbacks?.onDone?.()
    await settle()

    expect(startOptions).toMatchObject({ disableAi: true, requireTranslation: true })
    expect(polishRequests().map((request) => request.text)).toEqual(['Original speech'])
    expect(session.getSnapshot()).toMatchObject({ state: 'listening', caption: 'Translated speech' })
  })

  it('shows the recognized original as untranslated when a managed server skipped the translation', async () => {
    const trace = enablePipelineDebug()
    let callbacks: TranscriptionCallbacks | undefined
    let startOptions: StartOptions | undefined
    const provider: TranscriptionProvider = { ...createTestProvider((value) => { callbacks = value }), mode: 'server' }
    provider.start = (options) => { startOptions = options; return true }
    session = new SystemAudioSession({
      getProvider: () => provider,
      acquire: async () => { leased = true },
      release: async () => { leased = false },
      overlay,
    })

    await session.start({ deviceId: '', targetLanguage: 'ru' })
    frames(20, 0.9)
    frames(15, 0)
    callbacks?.onASR?.({ text: 'Original speech', asrMs: 5, durationSec: 0.64 })
    callbacks?.onFinal?.({
      asrText: 'Original speech',
      llmText: '',
      asrMs: 5,
      llmMs: 0,
      durationSec: 0.64,
      aiStatus: 'skipped',
    })
    callbacks?.onDone?.()
    await settle()

    expect(startOptions).toMatchObject({ disableAi: false, requireTranslation: true })
    expect(session.getSnapshot()).toMatchObject({
      state: 'listening',
      caption: 'Original speech',
      error: '',
      warning: '',
      captionNotice: expect.stringContaining('not translated'),
    })
    expect(trace.getPipelineSnapshot().runs).toMatchObject([{ status: 'rejected' }])
  })

  it('keeps an ASR caption on its original hold deadline after finalization', async () => {
    let callbacks: TranscriptionCallbacks | undefined
    session = new SystemAudioSession({
      getProvider: () => createTestProvider((value) => { callbacks = value }),
      acquire: async () => { leased = true },
      release: async () => { leased = false },
      overlay,
    })

    await session.start({ deviceId: '', targetLanguage: 'ru', asrOnly: true })
    frames(20, 0.9)
    frames(15, 0)
    callbacks?.onASR?.({ text: 'Recognized caption', asrMs: 5, durationSec: 0.64 })
    expect(session.getSnapshot().caption).toBe('Recognized caption')

    await vi.advanceTimersByTimeAsync(1_000)
    callbacks?.onFinal?.({
      asrText: 'Recognized caption',
      llmText: '',
      asrMs: 5,
      llmMs: 0,
      durationSec: 0.64,
      aiStatus: 'skipped',
    })
    callbacks?.onDone?.()
    await vi.advanceTimersByTimeAsync(6_999)
    expect(session.getSnapshot().caption).toBe('Recognized caption')

    await vi.advanceTimersByTimeAsync(1)
    expect(session.getSnapshot().caption).toBe('')
  })

  it('does not republish a recognition-only caption if final arrives after its hold expires', async () => {
    let callbacks: TranscriptionCallbacks | undefined
    session = new SystemAudioSession({
      getProvider: () => createTestProvider((value) => { callbacks = value }),
      acquire: async () => { leased = true },
      release: async () => { leased = false },
      overlay,
    })

    await session.start({ deviceId: '', targetLanguage: 'ru', asrOnly: true })
    frames(20, 0.9)
    frames(15, 0)
    callbacks?.onASR?.({ text: 'Expired caption', asrMs: 5, durationSec: 0.64 })
    expect(session.getSnapshot().caption).toBe('Expired caption')
    await vi.advanceTimersByTimeAsync(8_000)
    expect(session.getSnapshot().caption).toBe('')

    callbacks?.onFinal?.({
      asrText: 'Expired caption',
      llmText: '',
      asrMs: 5,
      llmMs: 0,
      durationSec: 0.64,
      aiStatus: 'skipped',
    })
    callbacks?.onDone?.()

    expect(session.getSnapshot().caption).toBe('')
    expect(overlayCalls.filter((call) => call.method === 'update' && call.payload.subtitleText === 'Expired caption')).toHaveLength(1)
  })

  it('publishes the final ASR text when an ASR callback was not emitted', async () => {
    const trace = enablePipelineDebug()
    let callbacks: TranscriptionCallbacks | undefined
    session = new SystemAudioSession({
      getProvider: () => createTestProvider((value) => { callbacks = value }),
      acquire: async () => { leased = true },
      release: async () => { leased = false },
      overlay,
    })

    await session.start({ deviceId: '', targetLanguage: 'ru', asrOnly: true })
    frames(20, 0.9)
    frames(15, 0)
    callbacks?.onFinal?.({
      asrText: 'Final ASR fallback',
      llmText: '',
      asrMs: 7,
      llmMs: 0,
      durationSec: 0.64,
      aiStatus: 'skipped',
    })
    callbacks?.onDone?.()
    await settle()

    expect(session.getSnapshot()).toMatchObject({ state: 'listening', caption: 'Final ASR fallback', error: '' })
    expect(trace.getPipelineSnapshot().runs).toMatchObject([{ status: 'ok', asrOnly: true, asrMs: 7, llmMs: 0 }])
  })

  it('does not let an earlier recognition-only timer clear a newer caption', async () => {
    let callbacks: TranscriptionCallbacks | undefined
    session = new SystemAudioSession({
      getProvider: () => createTestProvider((value) => { callbacks = value }),
      acquire: async () => { leased = true },
      release: async () => { leased = false },
      overlay,
    })
    const submitSegment = () => {
      frames(20, 0.9)
      frames(15, 0)
    }
    const finalize = (text: string) => {
      callbacks?.onASR?.({ text, asrMs: 5, durationSec: 0.64 })
      callbacks?.onFinal?.({ asrText: text, llmText: '', asrMs: 5, llmMs: 0, durationSec: 0.64, aiStatus: 'skipped' })
      callbacks?.onDone?.()
    }

    await session.start({ deviceId: '', targetLanguage: 'ru', asrOnly: true })
    submitSegment()
    finalize('First caption')
    await settle()
    await vi.advanceTimersByTimeAsync(4_000)

    submitSegment()
    finalize('Second caption')
    expect(session.getSnapshot().caption).toBe('Second caption')
    await vi.advanceTimersByTimeAsync(4_000)
    expect(session.getSnapshot().caption).toBe('Second caption')
    await vi.advanceTimersByTimeAsync(4_000)
    expect(session.getSnapshot().caption).toBe('')
  })

  it('keeps translated captions final-only and on the same hold interval', async () => {
    let callbacks: TranscriptionCallbacks | undefined
    session = new SystemAudioSession({
      getProvider: () => createTestProvider((value) => { callbacks = value }),
      acquire: async () => { leased = true },
      release: async () => { leased = false },
      overlay,
    })

    await session.start({ deviceId: '', targetLanguage: 'ru' })
    frames(20, 0.9)
    frames(15, 0)
    callbacks?.onASR?.({ text: 'Original speech', asrMs: 5, durationSec: 0.64 })
    expect(session.getSnapshot().caption).toBe('')
    callbacks?.onFinal?.({
      asrText: 'Original speech',
      llmText: '',
      asrMs: 5,
      llmMs: 0,
      durationSec: 0.64,
      aiStatus: 'skipped',
    })
    callbacks?.onDone?.()
    await settle()
    expect(session.getSnapshot().caption).toBe('Translated speech')
    await vi.advanceTimersByTimeAsync(7_999)
    expect(session.getSnapshot().caption).toBe('Translated speech')
    await vi.advanceTimersByTimeAsync(1)
    expect(session.getSnapshot().caption).toBe('')
  })

  it('records timings and engine metadata for a translated subtitle run', async () => {
    const trace = enablePipelineDebug()
    let callbacks: TranscriptionCallbacks | undefined
    const original = native.invoke.getMockImplementation()!
    native.invoke.mockImplementation((name, args) => name === 'cloud_polish'
      ? Promise.resolve({ text: 'Translated speech', elapsed_ms: 34 })
      : original(name, args))
    session = new SystemAudioSession({
      getProvider: () => createTestProvider((value) => { callbacks = value }),
      acquire: async () => { leased = true },
      release: async () => { leased = false },
      overlay,
    })
    await session.start({ deviceId: '', targetLanguage: 'ru' })
    frames(20, 0.9)
    frames(15, 0)
    callbacks?.onFinal?.({
      asrText: 'Original speech',
      llmText: '',
      asrMs: 12,
      llmMs: 0,
      durationSec: 0.64,
      asrEngine: 'test-engine',
      asrModel: 'test-model',
      aiStatus: 'skipped',
    })
    callbacks?.onDone?.()
    await settle()

    expect(trace.getPipelineSnapshot().runs).toMatchObject([{
      mode: 'local',
      speechMs: expect.any(Number),
      asrMs: 12,
      llmMs: 34,
      status: 'ok',
      asrEngine: 'test-engine',
      asrModel: 'test-model',
      aiProvider: 'ollama',
      aiModel: 'translator',
    }])
    expect(trace.getPipelineSnapshot().runs[0].speechMs).toBeGreaterThan(0)
    expect(trace.getPipelineSnapshot().runs[0].overlayMs).not.toBeNull()
  })

  it('fills missing local ASR metadata from the session model setting', async () => {
    const trace = enablePipelineDebug()
    native.settings.set('localAsr.modelId', 'configured-local-model')
    let callbacks: TranscriptionCallbacks | undefined
    session = new SystemAudioSession({
      getProvider: () => createTestProvider((value) => { callbacks = value }),
      acquire: async () => { leased = true },
      release: async () => { leased = false },
      overlay,
    })
    await session.start({ deviceId: '', targetLanguage: 'ru' })
    frames(20, 0.9)
    frames(15, 0)
    callbacks?.onASR?.({ text: 'Original speech', asrMs: 12, durationSec: 0.64 })
    callbacks?.onFinal?.({
      asrText: 'Original speech',
      llmText: 'Translated speech',
      asrMs: 12,
      llmMs: 34,
      durationSec: 0.64,
      aiStatus: 'applied',
    })
    callbacks?.onDone?.()
    await settle()

    expect(trace.getPipelineSnapshot().runs).toMatchObject([{
      status: 'ok',
      asrEngine: 'local',
      asrModel: 'configured-local-model',
    }])
  })

  it('tracks listening, ASR, translation, and completion activity phases', async () => {
    const trace = enablePipelineDebug()
    let callbacks: TranscriptionCallbacks | undefined
    session = new SystemAudioSession({
      getProvider: () => createTestProvider((value) => { callbacks = value }),
      acquire: async () => { leased = true },
      release: async () => { leased = false },
      overlay,
    })
    await session.start({ deviceId: '', targetLanguage: 'ru' })

    expect(trace.getPipelineSnapshot().activity.phase).toBe('listening')
    frames(20, 0.9)
    frames(15, 0)
    expect(trace.getPipelineSnapshot().activity.phase).toBe('asr')
    frames(1, 0)
    expect(trace.getPipelineSnapshot().activity.phase).toBe('asr')

    callbacks?.onASR?.({ text: 'Original speech', asrMs: 12, durationSec: 0.64 })
    expect(trace.getPipelineSnapshot().activity.phase).toBe('translation')
    frames(1, 0)
    expect(trace.getPipelineSnapshot().activity.phase).toBe('translation')
    callbacks?.onFinal?.({
      asrText: 'Original speech',
      llmText: 'Translated speech',
      asrMs: 12,
      llmMs: 34,
      durationSec: 0.64,
      aiStatus: 'applied',
    })
    callbacks?.onDone?.()
    callbacks?.onASR?.({ text: 'Late transcript', asrMs: 1, durationSec: 1 })

    expect(trace.getPipelineSnapshot().activity).toMatchObject({ phase: 'listening', stageStartedAt: null })
  })

  it('records an empty-ASR run without interrupting the subtitle session', async () => {
    const trace = enablePipelineDebug()
    let callbacks: TranscriptionCallbacks | undefined
    session = new SystemAudioSession({
      getProvider: () => createTestProvider((value) => { callbacks = value }),
      acquire: async () => { leased = true },
      release: async () => { leased = false },
      overlay,
    })
    await session.start({ deviceId: '', targetLanguage: 'ru' })
    frames(20, 0.9)
    frames(15, 0)
    callbacks?.onFinal?.({ asrText: '', llmText: '', asrMs: 5, llmMs: 0, durationSec: 0.64 })
    callbacks?.onDone?.()
    await settle()

    expect(session.getSnapshot().state).toBe('listening')
    expect(trace.getPipelineSnapshot().runs).toMatchObject([{ status: 'empty' }])
    expect(trace.getPipelineSnapshot().counters.failed).toBe(1)
  })

  it('uses the subtitle source language instead of the microphone dictation language', async () => {
    native.settings.set('speechInput.language', 'ru')
    native.settings.set('systemAudio.sourceLanguage', 'en')
    await session.start({ deviceId: 'speakers', targetLanguage: 'ru' })
    frames(20, 0.9)
    frames(15, 0)
    await settle()

    expect(native.transcribeArgs[0]?.language).toBe('en')
    expect(native.transcribeArgs[0]?.language).not.toBe('ru')
  })

  it('defaults subtitle recognition to auto when its source language is unset', async () => {
    native.settings.set('speechInput.language', 'ru')
    native.settings.delete('systemAudio.sourceLanguage')
    await session.start({ deviceId: 'speakers', targetLanguage: 'ru' })
    frames(20, 0.9)
    frames(15, 0)
    await settle()

    expect(native.transcribeArgs[0]?.language).toBe('auto')
    expect(native.transcribeArgs[0]?.language).not.toBe('ru')
  })

  it('translates speech using the active AI even when dictation cleanup is disabled, without mutating dictation settings', async () => {
    const before = new Map(native.settings)
    await session.start({ deviceId: 'speakers', targetLanguage: 'ru' })
    expect(session.getSnapshot().state).toBe('listening')
    frames(20, 0.9)
    frames(15, 0)
    await settle()

    expect(session.getSnapshot().caption).toBe('Translated speech')
    expect(native.captured[0]?.length).toBe(35 * 1024)
    expect(native.settings).toEqual(before)
    const request = native.invoke.mock.calls.find(([name]) => name === 'cloud_polish')?.[1].request
    expect(request.system_prompt).toContain('Russian')
    expect(request.system_prompt).toContain('live subtitle translator')
    expect(request.text_context).toBeNull()
    expect(native.invoke.mock.calls.some(([name]) => ['paste_text', 'copy_text', 'mute_system_output', 'get_recording_context'].includes(name))).toBe(false)
  })

  describe('overlay status line', () => {
    const statuses = () => overlayCalls.flatMap((call) => call.method === 'hide' ? [] : [call.payload.subtitleStatus])
    const lastStatus = () => statuses()[statuses().length - 1]

    it('says nothing while listening, so only captions appear over the video', async () => {
      await session.start({ deviceId: '', targetLanguage: 'ru' })
      expect(session.getSnapshot().state).toBe('listening')

      expect(lastStatus()).toBe('')
    })

    it('still names the other states, which would otherwise leave the overlay blank', async () => {
      await session.start({ deviceId: '', targetLanguage: 'ru' })
      expect(statuses()[0]).toBe('Starting computer subtitles...')

      await session.pause()
      expect(lastStatus()).toBe('Subtitles paused')
    })

    it('still shows a warning while listening', async () => {
      await session.start({ deviceId: '', targetLanguage: 'ru' })
      frames(1, 0, 0, undefined, true)
      await settle()

      expect(session.getSnapshot().state).toBe('listening')
      expect(lastStatus()).toContain('listening continues')
    })
  })

  describe('dual subtitles', () => {
    function speak() {
      frames(20, 0.9)
      frames(15, 0)
    }

    const lastOverlayPayload = () => {
      const updates = overlayCalls.filter((call): call is Extract<OverlayCall, { method: 'update' }> => call.method === 'update')
      return updates[updates.length - 1].payload
    }

    // A translation that stays pending until the test releases it.
    function holdTranslation() {
      const pending = deferred<{ text: string; elapsed_ms: number }>()
      const original = native.invoke.getMockImplementation()!
      native.invoke.mockImplementation((name, args) => name === 'cloud_polish' ? pending.promise : original(name, args))
      return pending
    }

    function numberRecognizedSpeech() {
      let heard = 0
      const original = native.invoke.getMockImplementation()!
      native.invoke.mockImplementation(async (name, args) => {
        const result = await original(name, args)
        return name === 'local_transcribe' ? { ...result, text: `Speech ${++heard}` } : result
      })
    }

    it('is off by default: the recognized text is never shown next to the translation', async () => {
      const pending = holdTranslation()
      await session.start({ deviceId: '', targetLanguage: 'ru' })
      speak()
      await settle()
      expect(session.getSnapshot()).toMatchObject({ caption: '', source: '' })

      pending.resolve({ text: 'Translated speech', elapsed_ms: 5 })
      await settle()
      expect(session.getSnapshot()).toMatchObject({ caption: 'Translated speech', source: '' })
      expect(lastOverlayPayload()).toMatchObject({ subtitleText: 'Translated speech', subtitleSource: '' })
    })

    it('shows the recognized text as soon as it is recognized, then the translation next to it', async () => {
      native.settings.set('systemAudio.dualSubtitles', true)
      const pending = holdTranslation()
      await session.start({ deviceId: '', targetLanguage: 'ru' })
      speak()
      await settle()

      expect(session.getSnapshot()).toMatchObject({ caption: '', source: 'Original speech' })
      expect(lastOverlayPayload()).toMatchObject({ subtitleText: '', subtitleSource: 'Original speech' })

      pending.resolve({ text: 'Translated speech', elapsed_ms: 5 })
      await settle()
      expect(session.getSnapshot()).toMatchObject({ caption: 'Translated speech', source: 'Original speech' })
      expect(lastOverlayPayload()).toMatchObject({ subtitleText: 'Translated speech', subtitleSource: 'Original speech' })
    })

    it('replaces the previous pair as soon as the next fragment is recognized', async () => {
      native.settings.set('systemAudio.dualSubtitles', true)
      numberRecognizedSpeech()
      const original = native.invoke.getMockImplementation()!
      let polishes = 0
      const second = deferred<{ text: string; elapsed_ms: number }>()
      native.invoke.mockImplementation((name, args) => name === 'cloud_polish' && ++polishes === 2 ? second.promise : original(name, args))
      await session.start({ deviceId: '', targetLanguage: 'ru' })
      speak()
      await settle()
      expect(session.getSnapshot()).toMatchObject({ caption: 'Translated speech', source: 'Speech 1' })

      speak()
      await settle()
      expect(session.getSnapshot()).toMatchObject({ caption: '', source: 'Speech 2' })

      second.resolve({ text: 'Second translation', elapsed_ms: 5 })
      await settle()
      expect(session.getSnapshot()).toMatchObject({ caption: 'Second translation', source: 'Speech 2' })
    })

    it.each([
      { name: 'the translation fails', answer: () => Promise.reject(new Error('AI unavailable')) },
      { name: 'the translation equals the original', answer: () => Promise.resolve({ text: 'Original speech', elapsed_ms: 5 }) },
    ])('shows the original once, as the main caption with its notice, when $name', async ({ answer }) => {
      native.settings.set('systemAudio.dualSubtitles', true)
      const original = native.invoke.getMockImplementation()!
      native.invoke.mockImplementation((name, args) => name === 'cloud_polish' ? answer() : original(name, args))
      await session.start({ deviceId: '', targetLanguage: 'ru' })
      speak()
      await settle()

      expect(session.getSnapshot()).toMatchObject({ state: 'listening', caption: 'Original speech', source: '' })
      expect(session.getSnapshot().captionNotice).toContain('not translated')
      expect(lastOverlayPayload()).toMatchObject({ subtitleText: 'Original speech', subtitleSource: '' })
    })

    it('is ignored in recognition-only mode, which already shows the recognized text', async () => {
      native.settings.set('systemAudio.dualSubtitles', true)
      await session.start({ deviceId: '', targetLanguage: '', asrOnly: true })
      speak()
      await settle()

      expect(session.getSnapshot()).toMatchObject({ caption: 'Original speech', source: '' })
    })

    it('clears the translation and its original together after the hold time', async () => {
      native.settings.set('systemAudio.dualSubtitles', true)
      await session.start({ deviceId: '', targetLanguage: 'ru' })
      speak()
      await settle()
      expect(session.getSnapshot()).toMatchObject({ caption: 'Translated speech', source: 'Original speech' })

      await vi.advanceTimersByTimeAsync(7_999)
      expect(session.getSnapshot()).toMatchObject({ caption: 'Translated speech', source: 'Original speech' })
      await vi.advanceTimersByTimeAsync(1)
      expect(session.getSnapshot()).toMatchObject({ caption: '', source: '' })
      expect(lastOverlayPayload()).toMatchObject({ subtitleText: '', subtitleSource: '' })
    })

    it('drops an original whose translation never arrives after the hold time, instead of leaving it on screen', async () => {
      native.settings.set('systemAudio.dualSubtitles', true)
      let callbacks: TranscriptionCallbacks | undefined
      session = new SystemAudioSession({
        getProvider: () => createTestProvider((value) => { callbacks = value }),
        acquire: async () => { leased = true },
        release: async () => { leased = false },
        overlay,
      })
      await session.start({ deviceId: '', targetLanguage: 'ru' })
      speak()
      callbacks?.onASR?.({ text: 'Original speech', asrMs: 5, durationSec: 0.64 })
      expect(session.getSnapshot().source).toBe('Original speech')

      await vi.advanceTimersByTimeAsync(7_999)
      expect(session.getSnapshot().source).toBe('Original speech')
      await vi.advanceTimersByTimeAsync(1)
      expect(session.getSnapshot()).toMatchObject({ caption: '', source: '' })
    })

    it('clears the source when the session stops', async () => {
      native.settings.set('systemAudio.dualSubtitles', true)
      holdTranslation()
      await session.start({ deviceId: '', targetLanguage: 'ru' })
      speak()
      await settle()
      expect(session.getSnapshot().source).toBe('Original speech')
      await session.stop()

      expect(session.getSnapshot()).toMatchObject({ state: 'idle', caption: '', source: '' })
    })

    it('reads the setting once per start, so a running session keeps its layout', async () => {
      holdTranslation()
      await session.start({ deviceId: '', targetLanguage: 'ru' })
      native.settings.set('systemAudio.dualSubtitles', true)
      speak()
      await settle()

      expect(session.getSnapshot().source).toBe('')
    })
  })

  describe('translation context', () => {
    it('gives each segment the speech recognized just before it, and nothing for the first one', async () => {
      numberRecognizedSpeech()
      await session.start({ deviceId: '', targetLanguage: 'uk' })
      speak()
      await settle()
      speak()
      await settle()
      speak()
      await settle()

      const requests = polishRequests()
      expect(requests.map((request) => request.text)).toEqual(['Speech 1', 'Speech 2', 'Speech 3'])
      expect(requests[0].text_context).toBeNull()
      expect(requests[1].text_context).toEqual({ source: 'subtitles', textBefore: 'Speech 1', selectedText: '', textAfter: '', selectionTruncated: false })
      expect(requests[2].text_context.textBefore).toBe('Speech 1 Speech 2')
    })

    it('does not carry context over a long pause', async () => {
      numberRecognizedSpeech()
      await session.start({ deviceId: '', targetLanguage: 'uk' })
      speak()
      await settle()
      vi.advanceTimersByTime(8_000)
      speak()
      await settle()

      expect(polishRequests().map((request) => request.text_context)).toEqual([null, null])
    })

    it('forgets the context when the session is stopped and started again', async () => {
      numberRecognizedSpeech()
      await session.start({ deviceId: '', targetLanguage: 'uk' })
      speak()
      await settle()
      await session.stop()
      await session.start({ deviceId: '', targetLanguage: 'uk' })
      speak()
      await settle()

      expect(polishRequests().map((request) => request.text_context)).toEqual([null, null])
    })

    it('does not send context to a provider that cannot take it', async () => {
      numberRecognizedSpeech()
      const provider: TranscriptionProvider = new LocalProvider()
      provider.acceptsTextContext = () => false
      session = new SystemAudioSession({
        getProvider: () => provider,
        acquire: async () => { leased = true },
        release: async () => { leased = false },
        overlay,
      })
      await session.start({ deviceId: '', targetLanguage: 'uk' })
      speak()
      await settle()
      speak()
      await settle()

      expect(polishRequests().map((request) => request.text_context)).toEqual([null, null])
    })

    it('keeps recognition-only runs free of translation context', async () => {
      numberRecognizedSpeech()
      await session.start({ deviceId: '', targetLanguage: '', asrOnly: true })
      speak()
      await settle()
      speak()
      await settle()

      expect(polishRequests()).toHaveLength(0)
      expect(session.getSnapshot().caption).toBe('Speech 2')
    })
  })

  it('ignores silence and retains every voiced frame across a forced split and its short tail', async () => {
    await session.start({ deviceId: '', targetLanguage: 'uk' })
    frames(100, 0)
    await settle()
    expect(native.captured).toHaveLength(0)
    frames(200, 0.9, 77)
    frames(15, 0)
    await settle()

    const voicedSamples = native.captured.reduce((count, audio) => count + [...new Int16Array(audio.buffer)].filter((sample) => sample === 77).length, 0)
    expect(voicedSamples).toBe(200 * 512)
    expect(native.captured.length).toBeGreaterThanOrEqual(2)
    expect(native.captured.every((audio) => audio.length <= 188 * 1024)).toBe(true)
  })

  it('moves a forced cut into the quietest part of the tail and carries the remainder into the next segment', async () => {
    await session.start({ deviceId: '', targetLanguage: 'uk' })
    frames(150, 0.9, 11)
    frames(2, 0.05, 22)
    frames(60, 0.9, 33)
    frames(15, 0, 0)
    await settle()

    expect(native.captured).toHaveLength(2)
    const first = new Int16Array(native.captured[0].buffer)
    const second = new Int16Array(native.captured[1].buffer)
    expect(native.captured[0].length).toBe(152 * 1024)
    expect(first.includes(33)).toBe(false)
    expect(first[first.length - 1]).toBe(22)
    expect(native.captured[1].length).toBe(75 * 1024)
    expect(second[0]).toBe(33)
    expect([...second].filter((sample) => sample === 33)).toHaveLength(60 * 512)
  })

  it('splits at a short pause once the segment is long enough, keeping the following speech', async () => {
    await session.start({ deviceId: '', targetLanguage: 'uk' })
    frames(130, 0.9, 11)
    frames(5, 0, 22)
    await settle()

    expect(native.captured).toHaveLength(1)
    expect(native.captured[0].length).toBe(135 * 1024)

    frames(30, 0.9, 33)
    frames(15, 0, 0)
    await settle()

    expect(native.captured).toHaveLength(2)
    const second = new Int16Array(native.captured[1].buffer)
    expect(second[0]).toBe(33)
    expect([...second].filter((sample) => sample === 33)).toHaveLength(30 * 512)
  })

  describe('segment close reasons in the pipeline trace', () => {
    async function closeReasons() {
      await settle()
      return getPipelineSnapshot().runs.map((run) => run.closeReason)
    }

    beforeEach(() => { enablePipelineDebug() })

    it('records the end of speech after the silence timeout', async () => {
      await session.start({ deviceId: '', targetLanguage: 'uk' })
      frames(20, 0.9)
      frames(15, 0)

      expect(await closeReasons()).toEqual(['silence'])
    })

    it('records an early cut at a pause once the segment is long enough', async () => {
      await session.start({ deviceId: '', targetLanguage: 'uk' })
      frames(130, 0.9)
      frames(5, 0)

      expect(await closeReasons()).toEqual(['pause'])
    })

    it('records a forced cut at the length limit', async () => {
      await session.start({ deviceId: '', targetLanguage: 'uk' })
      frames(188, 0.9)

      expect(await closeReasons()).toEqual(['cap'])
    })

    it('records an audio stop after silence as a plain gap', async () => {
      await session.start({ deviceId: '', targetLanguage: 'uk' })
      frames(20, 0.9)
      frames(3, 0)
      await vi.advanceTimersByTimeAsync(600)

      expect(await closeReasons()).toEqual(['gap'])
    })

    it('records frames stopping while the last frame was still voiced as a mid-speech dropout', async () => {
      await session.start({ deviceId: '', targetLanguage: 'uk' })
      frames(20, 0.9)
      await vi.advanceTimersByTimeAsync(600)

      expect(await closeReasons()).toEqual(['dropout'])
    })

    it('records a late frame that closes the open segment the same way as the timer', async () => {
      await session.start({ deviceId: '', targetLanguage: 'uk' })
      frames(20, 0.9)
      vi.setSystemTime(Date.now() + 600)
      frames(1, 0.9)

      expect(await closeReasons()).toEqual(['dropout'])
    })
  })

  describe('frame gaps while speech is open', () => {
    const maxGap = () => getPipelineSnapshot().counters.maxSpeechGapMs

    beforeEach(() => { enablePipelineDebug() })

    it('records the longest delay between received frames during speech', async () => {
      await session.start({ deviceId: '', targetLanguage: 'uk' })
      frames(1, 0.9)
      vi.setSystemTime(Date.now() + 40)
      frames(1, 0.9)
      vi.setSystemTime(Date.now() + 250)
      frames(1, 0.9)
      vi.setSystemTime(Date.now() + 60)
      frames(1, 0.9)

      expect(maxGap()).toBe(250)
    })

    it('counts a gap that closed the segment, at least as long as the receive timeout', async () => {
      await session.start({ deviceId: '', targetLanguage: 'uk' })
      frames(20, 0.9)
      await vi.advanceTimersByTimeAsync(600)

      expect(maxGap()).toBe(512)
    })

    it('ignores delays between utterances, short or long, which are not a delivery problem', async () => {
      await session.start({ deviceId: '', targetLanguage: 'uk' })
      frames(1, 0)
      vi.setSystemTime(Date.now() + 300)
      frames(1, 0)
      expect(maxGap()).toBe(0)

      vi.setSystemTime(Date.now() + 5_000)
      frames(1, 0)
      expect(maxGap()).toBe(0)
    })
  })

  it('does not split at a short pause before the segment reaches the soft limit', async () => {
    await session.start({ deviceId: '', targetLanguage: 'uk' })
    frames(100, 0.9)
    frames(8, 0)
    await settle()
    expect(native.captured).toHaveLength(0)

    frames(7, 0)
    await settle()
    expect(native.captured).toHaveLength(1)
    expect(native.captured[0].length).toBe(115 * 1024)
  })

  it('cuts at the 3 s minimum of the maximum segment length setting', async () => {
    native.settings.set('systemAudio.maxSegmentSec', 3)
    await session.start({ deviceId: '', targetLanguage: 'uk' })
    frames(93, 0.9)
    await settle()
    expect(native.captured).toHaveLength(0)

    frames(7, 0.9)
    await settle()
    expect(native.captured).toHaveLength(1)
    expect(native.captured[0].length).toBe(94 * 1024)
  })

  it('cuts at an intermediate maximum segment length', async () => {
    native.settings.set('systemAudio.maxSegmentSec', 4.5)
    await session.start({ deviceId: '', targetLanguage: 'uk' })
    frames(140, 0.9)
    await settle()
    expect(native.captured).toHaveLength(0)

    frames(1, 0.9)
    await settle()
    expect(native.captured).toHaveLength(1)
    expect(native.captured[0].length).toBe(141 * 1024)
  })

  it('splits at a pause once two thirds of an intermediate maximum are reached', async () => {
    native.settings.set('systemAudio.maxSegmentSec', 4.5)
    await session.start({ deviceId: '', targetLanguage: 'uk' })
    frames(94, 0.9, 11)
    frames(5, 0, 22)
    await settle()

    expect(native.captured).toHaveLength(1)
    expect(native.captured[0].length).toBe(99 * 1024)
  })

  it('falls back to the 6 s cap when the stored maximum is outside the supported range', async () => {
    native.settings.set('systemAudio.maxSegmentSec', 12)
    await session.start({ deviceId: '', targetLanguage: 'uk' })
    frames(187, 0.9)
    await settle()
    expect(native.captured).toHaveLength(0)

    frames(1, 0.9)
    await settle()
    expect(native.captured).toHaveLength(1)
    expect(native.captured[0].length).toBe(188 * 1024)
  })

  it('keeps the original 6 s cut for the default medium segment length', async () => {
    await session.start({ deviceId: '', targetLanguage: 'uk' })
    frames(187, 0.9)
    await settle()
    expect(native.captured).toHaveLength(0)

    frames(1, 0.9)
    await settle()
    expect(native.captured).toHaveLength(1)
    expect(native.captured[0].length).toBe(188 * 1024)
  })

  describe('failure tolerance', () => {
    function speak() {
      frames(20, 0.9)
      frames(15, 0)
    }

    // Scripted AI answers, one per translated fragment; the last entry repeats.
    function scriptAi(...answers: Array<'ok' | 'fail' | 'same'>) {
      let index = 0
      const original = native.invoke.getMockImplementation()!
      native.invoke.mockImplementation((name, args) => {
        if (name !== 'cloud_polish') return original(name, args)
        const answer = answers[Math.min(index++, answers.length - 1)]
        if (answer === 'fail') return Promise.reject(new Error('AI unavailable'))
        return Promise.resolve({ text: answer === 'same' ? 'Original speech' : 'Translated speech', elapsed_ms: 5 })
      })
    }

    it('shows the recognized original marked as untranslated when the AI fails, and keeps listening', async () => {
      scriptAi('fail')
      await session.start({ deviceId: '', targetLanguage: 'ru' })
      speak()
      await settle()

      expect(session.getSnapshot()).toMatchObject({ state: 'listening', caption: 'Original speech', error: '', warning: '' })
      expect(session.getSnapshot().captionNotice).toContain('not translated')
    })

    it('publishes the untranslated mark as its own overlay field, next to the untouched caption and status', async () => {
      scriptAi('fail')
      await session.start({ deviceId: '', targetLanguage: 'ru' })
      speak()
      await settle()

      const published = [...overlayCalls].reverse().find(
        (call): call is Extract<OverlayCall, { method: 'update' }> => call.method === 'update' && call.payload.subtitleText === 'Original speech',
      )
      expect(published?.payload.subtitleNotice).toContain('not translated')
      expect(published?.payload.subtitleStatus).not.toContain('not translated')
    })

    it('clears the untranslated mark together with the caption it describes', async () => {
      scriptAi('fail')
      await session.start({ deviceId: '', targetLanguage: 'ru' })
      speak()
      await settle()
      expect(session.getSnapshot().captionNotice).toContain('not translated')

      await vi.advanceTimersByTimeAsync(8_000)

      expect(session.getSnapshot()).toMatchObject({ caption: '', captionNotice: '' })
    })

    it('shows an identical translation as the original, marked, and never counts it as a failure', async () => {
      scriptAi('same')
      await session.start({ deviceId: '', targetLanguage: 'ru' })
      for (let index = 0; index < 5; index++) {
        speak()
        await settle()
      }

      expect(session.getSnapshot()).toMatchObject({ state: 'listening', caption: 'Original speech', error: '', warning: '' })
      expect(session.getSnapshot().captionNotice).toContain('not translated')
    })

    it('replaces the untranslated mark once a translation succeeds', async () => {
      scriptAi('fail', 'ok')
      await session.start({ deviceId: '', targetLanguage: 'ru' })
      speak()
      await settle()
      speak()
      await settle()

      expect(session.getSnapshot()).toMatchObject({ state: 'listening', caption: 'Translated speech', warning: '', captionNotice: '' })
    })

    it('stops with the translation error only after three failures in a row', async () => {
      scriptAi('fail')
      await session.start({ deviceId: '', targetLanguage: 'ru' })
      for (let index = 0; index < 2; index++) {
        speak()
        await settle()
        expect(session.getSnapshot().state).toBe('listening')
      }
      speak()
      await settle()

      expect(session.getSnapshot().state).toBe('error')
      expect(session.getSnapshot().caption).toBe('')
      expect(session.getSnapshot().error).toContain('Translation failed')
    })

    it('restarts the failure count after every success', async () => {
      scriptAi('fail', 'fail', 'ok', 'fail', 'fail')
      await session.start({ deviceId: '', targetLanguage: 'ru' })
      for (let index = 0; index < 5; index++) {
        speak()
        await settle()
      }

      expect(session.getSnapshot().state).toBe('listening')
    })

    it('starts counting from zero after the session is resumed', async () => {
      scriptAi('fail')
      await session.start({ deviceId: '', targetLanguage: 'ru' })
      for (let index = 0; index < 3; index++) {
        speak()
        await settle()
      }
      expect(session.getSnapshot().state).toBe('error')
      await session.resume()
      for (let index = 0; index < 2; index++) {
        speak()
        await settle()
      }

      expect(session.getSnapshot().state).toBe('listening')
    })

    it('skips a fragment whose recognition fails and keeps listening', async () => {
      const original = native.invoke.getMockImplementation()!
      let failures = 1
      native.invoke.mockImplementation((name, args) => name === 'local_transcribe' && failures-- > 0
        ? Promise.reject(new Error('ASR backend unavailable')) : original(name, args))
      await session.start({ deviceId: '', targetLanguage: 'ru' })
      speak()
      await settle()

      expect(session.getSnapshot().state).toBe('listening')
      expect(session.getSnapshot().warning).toContain('Fragment skipped')
      speak()
      await settle()
      expect(session.getSnapshot()).toMatchObject({ state: 'listening', caption: 'Translated speech', warning: '' })
    })

    it('stops with the provider error after three recognition failures in a row', async () => {
      const original = native.invoke.getMockImplementation()!
      native.invoke.mockImplementation((name, args) => name === 'local_transcribe'
        ? Promise.reject(new Error('ASR backend unavailable')) : original(name, args))
      await session.start({ deviceId: '', targetLanguage: 'ru' })
      for (let index = 0; index < 3; index++) {
        speak()
        await settle()
      }

      expect(session.getSnapshot().state).toBe('error')
      expect(session.getSnapshot().error).toBe(describeProviderError('Error: ASR backend unavailable').message)
    })

    it('abandons a fragment that never completes, ignores its late result, and keeps listening', async () => {
      const stuck = deferred<{ text: string; elapsed_ms: number }>()
      const original = native.invoke.getMockImplementation()!
      let calls = 0
      native.invoke.mockImplementation((name, args) => name === 'local_transcribe' && calls++ === 0 ? stuck.promise : original(name, args))
      await session.start({ deviceId: '', targetLanguage: 'ru' })
      speak()
      await settle()
      await vi.advanceTimersByTimeAsync(30_000)

      expect(session.getSnapshot().state).toBe('listening')
      expect(session.getSnapshot().warning).toContain('Fragment skipped')

      speak()
      await settle()
      expect(session.getSnapshot().caption).toBe('Translated speech')
      stuck.resolve({ text: 'Stale speech', elapsed_ms: 5 })
      await settle()
      expect(session.getSnapshot().caption).toBe('Translated speech')
    })

    it('cancels the provider run it gave up on, so a late result cannot be attached to a later fragment', async () => {
      const cancel = vi.fn()
      const provider = createTestProvider(() => {})
      provider.cancel = cancel
      session = new SystemAudioSession({
        getProvider: () => provider,
        acquire: async () => { leased = true },
        release: async () => { leased = false },
        overlay,
      })
      await session.start({ deviceId: '', targetLanguage: 'ru' })
      speak()
      await vi.advanceTimersByTimeAsync(29_999)
      expect(cancel).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)

      expect(cancel).toHaveBeenCalledTimes(1)
      expect(session.getSnapshot().state).toBe('listening')
    })

    it('keeps the interruption cause visible when native capture cleanup also fails', async () => {
      const original = native.invoke.getMockImplementation()!
      native.invoke.mockImplementation((name, args) => {
        if (name === 'cloud_polish') return Promise.reject(new Error('AI unavailable'))
        if (name === 'stop_system_audio_capture') return Promise.reject(new Error('Native cleanup unavailable'))
        return original(name, args)
      })
      await session.start({ deviceId: '', targetLanguage: 'ru' })
      for (let index = 0; index < 3; index++) {
        speak()
        await settle()
      }

      expect(session.getSnapshot().state).toBe('error')
      expect(session.getSnapshot().error).toContain('Translation failed')
      expect(session.getSnapshot().error).toContain('Could not safely return to dictation')
    })
  })

  it('does not publish a cancelled translation or process another segment before the first one finishes', async () => {
    const pending = deferred<{ text: string; elapsed_ms: number }>()
    const original = native.invoke.getMockImplementation()!
    native.invoke.mockImplementation((name, args) => name === 'local_transcribe' ? pending.promise : original(name, args))
    await session.start({ deviceId: '', targetLanguage: 'ru' })
    frames(200, 0.9)
    frames(15, 0)
    await settle()
    expect(native.invoke.mock.calls.filter(([name]) => name === 'local_transcribe')).toHaveLength(1)
    await session.stop()
    pending.resolve({ text: 'Stale speech', elapsed_ms: 5 })
    await settle()

    expect(session.getSnapshot().state).toBe('idle')
    expect(session.getSnapshot().caption).toBe('')
    expect(native.invoke.mock.calls.some(([name]) => name === 'cloud_polish')).toBe(false)
    expect(leased).toBe(false)
  })

  it('drops the oldest waiting speech and keeps listening when processing falls behind, instead of building an unbounded backlog', async () => {
    const pending = deferred<{ text: string; elapsed_ms: number }>()
    const original = native.invoke.getMockImplementation()!
    native.invoke.mockImplementation((name, args) => name === 'local_transcribe' ? pending.promise : original(name, args))
    const transcribed = () => native.invoke.mock.calls.filter(([name]) => name === 'local_transcribe')
      .map(([, args]) => new Int16Array(Uint8Array.from(atob(args.audioB64 as string), (char) => char.charCodeAt(0)).buffer)[0])
    await session.start({ deviceId: '', targetLanguage: 'en' })
    frames(188, 0.9, 11)
    await settle()
    frames(188, 0.9, 22)
    frames(188, 0.9, 33)
    frames(188, 0.9, 44)
    await settle()

    expect(session.getSnapshot().state).toBe('listening')
    expect(session.getSnapshot().warning).toContain('older speech was skipped')
    expect(transcribed()).toEqual([11])

    pending.resolve({ text: 'Late speech', elapsed_ms: 5 })
    await settle()
    expect(transcribed()).toEqual([11, 44])
  })

  it('marks the dropped speech as failed in the pipeline trace', async () => {
    const trace = enablePipelineDebug()
    const pending = deferred<{ text: string; elapsed_ms: number }>()
    const original = native.invoke.getMockImplementation()!
    native.invoke.mockImplementation((name, args) => name === 'local_transcribe' ? pending.promise : original(name, args))
    await session.start({ deviceId: '', targetLanguage: 'en' })
    frames(188, 0.9)
    await settle()
    frames(188 * 3, 0.9)
    await settle()

    const dropped = trace.getPipelineSnapshot().runs.filter((run) => run.status === 'failed')
    expect(dropped).toHaveLength(2)
    pending.resolve({ text: 'Late speech', elapsed_ms: 5 })
  })

  it('cleans up capture that finishes starting after a stop request', async () => {
    const pending = deferred<number>()
    const original = native.invoke.getMockImplementation()!
    native.invoke.mockImplementation((name, args) => name === 'start_system_audio_capture' ? pending.promise : original(name, args))
    const starting = session.start({ deviceId: '', targetLanguage: 'en' })
    await settle()
    const stopping = session.stop()
    pending.resolve(1)
    await Promise.all([starting, stopping])

    expect(session.getSnapshot().state).toBe('idle')
    expect(leased).toBe(false)
    expect(native.invoke.mock.calls.some(([name]) => name === 'stop_system_audio_capture')).toBe(true)
    expect(native.listeners.size).toBe(0)
  })

  it('waits for a pending subtitle update before hiding the overlay on stop', async () => {
    const pendingUpdate = deferred<void>()
    overlay.update = vi.fn((payload: SubtitleOverlayPayload) => {
      overlayCalls.push({ method: 'update', payload })
      return pendingUpdate.promise
    })
    await session.start({ deviceId: '', targetLanguage: 'en' })
    await settle()
    expect(overlayCalls.map((call) => call.method)).toEqual(['present', 'update'])

    const stopping = session.stop()
    await settle()
    expect(overlayCalls.map((call) => call.method)).toEqual(['present', 'update'])

    pendingUpdate.resolve()
    await stopping
    expect(overlayCalls.map((call) => call.method)).toEqual(['present', 'update', 'update', 'hide'])
  })

  it('skips a queued subtitle update when its generation changes before dispatch', async () => {
    const pendingUpdate = deferred<void>()
    overlay.update = vi.fn((payload: SubtitleOverlayPayload) => {
      overlayCalls.push({ method: 'update', payload })
      if (overlayCalls.filter((call) => call.method === 'update').length === 1) return pendingUpdate.promise
      return Promise.resolve()
    })
    let callbacks: TranscriptionCallbacks | undefined
    session = new SystemAudioSession({
      getProvider: () => createTestProvider((value) => { callbacks = value }),
      acquire: async () => { leased = true },
      release: async () => { leased = false },
      overlay,
    })
    await session.start({ deviceId: '', targetLanguage: 'en' })
    await settle()
    frames(20, 0.9)
    frames(15, 0)
    callbacks?.onFinal?.({
      asrText: 'Source speech',
      llmText: 'Queued stale caption',
      asrMs: 1,
      llmMs: 1,
      durationSec: 1,
      aiStatus: 'applied',
    })
    const pausing = session.pause()
    pendingUpdate.resolve()
    await pausing
    await settle()

    const updates = overlayCalls.filter((call) => call.method === 'update')
    expect(updates).toHaveLength(2)
    expect(updates.some((call) => call.payload.subtitleText === 'Queued stale caption')).toBe(false)
  })

  it('does not forward a provider callback from an old session generation to the subtitle overlay', async () => {
    const trace = enablePipelineDebug()
    const callbacksByGeneration: TranscriptionCallbacks[] = []
    session = new SystemAudioSession({
      getProvider: () => createTestProvider((callbacks) => { callbacksByGeneration.push(callbacks) }),
      acquire: async () => { leased = true },
      release: async () => { leased = false },
      overlay,
    })
    await session.start({ deviceId: '', targetLanguage: 'en' })
    await settle()
    expect(overlayCalls.map((call) => call.method)).toEqual(['present', 'update'])
    await session.stop()
    expect(overlayCalls.map((call) => call.method)).toEqual(['present', 'update', 'update', 'hide'])
    await session.start({ deviceId: '', targetLanguage: 'en' })
    await settle()
    frames(20, 0.9)
    frames(15, 0)
    callbacksByGeneration[1]?.onFinal?.({
      asrText: 'Current transcript',
      llmText: '',
      asrMs: 1,
      llmMs: 0,
      durationSec: 1,
      aiStatus: 'skipped',
    })
    await settle()
    expect(overlayCalls.some((call) => call.method === 'update'
      && call.payload.subtitleText === 'Translated speech')).toBe(true)
    const callsBeforeLateCallback = overlayCalls.slice()

    callbacksByGeneration[0]?.onFinal?.({
      asrText: 'Old transcript',
      llmText: 'Stale subtitle',
      asrMs: 1,
      llmMs: 1,
      durationSec: 1,
      aiStatus: 'applied',
    })
    callbacksByGeneration[0]?.onASR?.({ text: 'Old transcript', asrMs: 1, durationSec: 1 })
    await settle()

    expect(overlayCalls).toEqual(callsBeforeLateCallback)
    expect(trace.getPipelineSnapshot().activity).toMatchObject({ phase: 'listening' })
  })

  it('releases recorder ownership only after native capture cleanup and subtitle hiding complete', async () => {
    const releaseOrder: string[] = []
    const pendingHide = deferred<void>()
    const provider = createTestProvider(() => {}, () => releaseOrder.push('clear-work'))
    overlay.hide = vi.fn(() => {
      overlayCalls.push({ method: 'hide' })
      releaseOrder.push('hide')
      return pendingHide.promise
    })
    const invoke = native.invoke.getMockImplementation()!
    native.invoke.mockImplementation((name, args) => {
      if (name === 'stop_system_audio_capture') releaseOrder.push('stop-native')
      return invoke(name, args)
    })
    session = new SystemAudioSession({
      getProvider: () => provider,
      acquire: async () => { leased = true },
      release: async () => { releaseOrder.push('release'); leased = false },
      overlay,
    })
    await session.start({ deviceId: '', targetLanguage: 'en' })
    await settle()
    releaseOrder.length = 0

    const stopping = session.stop()
    await settle()
    const stopIndex = releaseOrder.indexOf('stop-native')
    const clearWorkIndex = releaseOrder.indexOf('clear-work', stopIndex + 1)
    const hideIndex = releaseOrder.indexOf('hide')
    expect(stopIndex).toBeGreaterThanOrEqual(0)
    expect(clearWorkIndex).toBeGreaterThan(stopIndex)
    expect(hideIndex).toBeGreaterThan(clearWorkIndex)
    expect(releaseOrder).not.toContain('release')
    expect(leased).toBe(true)
    expect(session.getSnapshot().state).toBe('stopping')

    pendingHide.resolve(undefined)
    await stopping
    expect(releaseOrder[releaseOrder.length - 1]).toBe('release')
    expect(leased).toBe(false)
    expect(session.getSnapshot().state).toBe('idle')
  })

  it('closes the final spoken fragment when playback stops producing packets', async () => {
    await session.start({ deviceId: '', targetLanguage: 'ru' })
    frames(20, 0.9)
    await vi.advanceTimersByTimeAsync(600)

    expect(session.getSnapshot().caption).toBe('Translated speech')
    expect(native.captured[0]?.length).toBe(20 * 1024)
  })

  it('holds the recorder lease while paused and ignores frames from the previous capture after resume', async () => {
    await session.start({ deviceId: '', targetLanguage: 'ru' })
    const oldId = native.invoke.mock.calls.find(([name]) => name === 'start_system_audio_capture')?.[1].sessionId
    await session.pause()
    expect(session.getSnapshot().state).toBe('paused')
    expect(leased).toBe(true)
    await session.resume()
    frames(20, 0.9, 99, oldId)
    frames(15, 0, 0, oldId)
    await settle()
    expect(native.captured).toHaveLength(0)
    frames(20, 0.9)
    frames(15, 0)
    await settle()
    expect(session.getSnapshot().caption).toBe('Translated speech')
  })

  it('keeps dictation blocked after capture cleanup fails, and can retry that cleanup', async () => {
    await session.start({ deviceId: '', targetLanguage: 'en' })
    const original = native.invoke.getMockImplementation()!
    let failStop = true
    native.invoke.mockImplementation((name, args) => name === 'stop_system_audio_capture' && failStop
      ? Promise.reject(new Error('Native cleanup unavailable')) : original(name, args))
    await session.stop()
    expect(session.getSnapshot().state).toBe('error')
    expect(leased).toBe(true)
    failStop = false
    await session.stop()
    expect(session.getSnapshot().state).toBe('idle')
    expect(leased).toBe(false)
  })

  it('translates Omni recognition with the selected client AI rather than exposing its untranslated final', async () => {
    native.settings.set('cloudAsr.profiles', [{
      id: 'omni', provider: 'qwen_omni_35_flash', apiKey: 'test-key', appId: '', model: 'qwen3.5-omni-flash', omniPrompt: '',
    }])
    native.settings.set('cloudAsr.activeProfileId', 'omni')
    session = new SystemAudioSession({
      getProvider: () => new CloudAPIProvider(),
      acquire: async () => { leased = true },
      release: async () => { leased = false },
      overlay,
    })
    await session.start({ deviceId: '', targetLanguage: 'ru' })
    frames(20, 0.9)
    frames(15, 0)
    await vi.advanceTimersByTimeAsync(1)

    expect(session.getSnapshot().state).toBe('listening')
    expect(session.getSnapshot().caption).toBe('Translated speech')
  })

  it.each([
    { finalText: 'Server translation', expectedCaption: 'Server translation', expectedNotice: '' },
    { finalText: 'Original speech', expectedCaption: 'Original speech', expectedNotice: 'not translated' },
  ] as const)('uses server-managed translation with the caption prompt and rejects late messages from the closed socket: $finalText', async ({ finalText, expectedCaption, expectedNotice }) => {
    const messages: Array<Record<string, unknown>> = []
    const sockets: ServerSocket[] = []
    class ServerSocket {
      static OPEN = 1
      readyState = 0
      onopen: (() => void) | null = null
      onmessage: ((event: { data: string }) => void) | null = null
      onclose: ((event: { code: number; reason: string }) => void) | null = null
      onerror = null
      binaryType = ''
      constructor() {
        sockets.push(this)
        queueMicrotask(() => {
          this.readyState = 1
          this.onopen?.()
          this.receive({ type: 'ready', asr: true, llm: true, connection_id: 'test-connection' })
        })
      }
      receive(data: Record<string, unknown>) { this.onmessage?.({ data: JSON.stringify(data) }) }
      send(data: string | ArrayBuffer) {
        if (typeof data !== 'string') return
        const message = JSON.parse(data)
        messages.push(message)
        if (message.cmd === 'stop') queueMicrotask(() => {
          this.receive({ type: 'final', asr_text: 'Original speech', llm_text: finalText, asr_ms: 5, llm_ms: 5, duration_sec: 1 })
          this.receive({ type: 'done' })
        })
      }
      close() { this.readyState = 3; this.onclose?.({ code: 1000, reason: '' }) }
    }
    vi.stubGlobal('WebSocket', ServerSocket)
    session = new SystemAudioSession({
      getProvider: () => new ServerProvider(),
      acquire: async () => { leased = true },
      release: async () => { leased = false },
      overlay,
    })
    await session.start({ deviceId: '', targetLanguage: 'ru' })
    frames(20, 0.9)
    frames(15, 0)
    await settle()

    expect(session.getSnapshot().state).toBe('listening')
    expect(session.getSnapshot().caption).toBe(expectedCaption)
    expect(session.getSnapshot().captionNotice).toContain(expectedNotice)
    expect(messages.find((message) => message.cmd === 'start')?.disable_ai).not.toBe(true)
    expect(messages.find((message) => message.cmd === 'start')?.system_prompt).toContain('Russian')
    expect(native.invoke.mock.calls.some(([name]) => name === 'cloud_polish')).toBe(false)
    await session.stop()
    sockets[0].receive({ type: 'final', asr_text: 'Stale', llm_text: 'Stale', asr_ms: 1, llm_ms: 1 })
    expect(session.getSnapshot().state).toBe('idle')
    expect(session.getSnapshot().caption).toBe('')
  })

  it('does not let an overdue inactivity timer close a newly received phrase', async () => {
    await session.start({ deviceId: '', targetLanguage: 'ru' })
    frames(20, 0.9)
    await vi.advanceTimersByTimeAsync(450)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600)
    frames(20, 0.9)
    await settle()
    expect(native.captured).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(native.captured).toHaveLength(1)
  })

  it('continues after a valid gap without joining old speech, losing the marked frame, or firing the old inactivity timer', async () => {
    await session.start({ deviceId: 'headphones', targetLanguage: 'ru' })
    frames(20, 0.9, 11)
    await vi.advanceTimersByTimeAsync(400)
    frames(1, 0.9, 88, undefined, true)
    frames(20, 0.9, 77)
    await settle()

    expect(session.getSnapshot().state).toBe('listening')
    expect(session.getSnapshot().error).toBe('')
    expect(session.getSnapshot().warning).toContain('listening continues')
    expect(overlayCalls.some((call) => call.method === 'update'
      && call.payload.subtitleStatus.includes('listening continues'))).toBe(true)
    await vi.advanceTimersByTimeAsync(120)
    expect(native.captured).toHaveLength(0)
    frames(15, 0, 0)
    await settle()

    const samples = new Int16Array(native.captured[0].buffer)
    expect(samples).toHaveLength(36 * 512)
    expect(samples.slice(0, 512)).toEqual(new Int16Array(512).fill(88))
    expect([...samples].filter((sample) => sample === 77)).toHaveLength(20 * 512)
    expect([...samples].includes(11)).toBe(false)
    expect(session.getSnapshot().caption).toBe('Translated speech')
    expect(session.getSnapshot().warning).toBe('')
    expect(leased).toBe(true)
  })

  it('preserves active and queued sealed jobs in order while discarding only the unfinished phrase at a gap', async () => {
    const jobs: ReturnType<typeof deferred<{ text: string; elapsed_ms: number }>>[] = []
    const original = native.invoke.getMockImplementation()!
    native.invoke.mockImplementation((name, args) => {
      if (name === 'local_transcribe') {
        const job = deferred<{ text: string; elapsed_ms: number }>()
        jobs.push(job)
        return job.promise
      }
      if (name === 'cloud_polish') return Promise.resolve({ text: `${args.request.text} translated`, elapsed_ms: 5 })
      return original(name, args)
    })
    await session.start({ deviceId: 'headphones', targetLanguage: 'ru' })
    frames(20, 0.9, 11)
    frames(15, 0, 0)
    await settle()
    frames(20, 0.9, 22)
    frames(15, 0, 0)
    frames(20, 0.9, 33)
    frames(1, 0.9, 88, undefined, true)
    frames(20, 0.9, 44)
    frames(15, 0, 0)
    expect(session.getSnapshot().state).toBe('listening')
    expect(jobs).toHaveLength(1)

    for (const [index, text] of ['A', 'B', 'D'].entries()) {
      expect(jobs).toHaveLength(index + 1)
      jobs[index].resolve({ text, elapsed_ms: 5 })
      await settle()
      expect(session.getSnapshot().caption).toBe(`${text} translated`)
    }
    const submitted = native.invoke.mock.calls.filter(([name]) => name === 'local_transcribe')
      .map(([, args]) => new Int16Array(Uint8Array.from(atob(args.audioB64), (char) => char.charCodeAt(0)).buffer))
    expect(submitted).toHaveLength(3)
    expect(submitted.map((samples) => samples[0])).toEqual([11, 22, 88])
    expect(submitted.every((samples) => ![...samples].includes(33))).toBe(true)
    expect([...submitted[2]].filter((sample) => sample === 44)).toHaveLength(20 * 512)
  })

  it('does not carry forced-split speech eligibility across a gap into subthreshold noise', async () => {
    await session.start({ deviceId: 'headphones', targetLanguage: 'ru' })
    frames(188, 0.9, 11)
    await settle()
    expect(native.captured).toHaveLength(1)
    frames(3, 0.9, 33)
    frames(1, 0, 0, undefined, true)
    frames(3, 0.9, 66)
    frames(15, 0, 0)
    await vi.advanceTimersByTimeAsync(600)

    expect(session.getSnapshot().state).toBe('listening')
    expect(native.captured).toHaveLength(1)
    await session.pause()
    expect(session.getSnapshot().warning).toBe('')
  })

  it.each(['malformed frame', 'device error'] as const)('still stops on a genuine %s even after a recoverable gap', async (failure) => {
    await session.start({ deviceId: 'headphones', targetLanguage: 'ru' })
    const id = native.invoke.mock.calls.find(([name]) => name === 'start_system_audio_capture')?.[1].sessionId
    frames(1, 0, 0, undefined, true)
    if (failure === 'malformed frame') {
      native.listeners.get('system-audio-frame')?.({ payload: { sessionId: id, audioB64: '!', speechProbability: 0.9, discontinuity: true } })
    } else {
      native.listeners.get('system-audio-error')?.({ payload: { sessionId: id, message: 'Output device invalidated' } })
    }
    await settle()

    expect(session.getSnapshot().state).toBe('error')
    expect(session.getSnapshot().error).toContain('capture this output device')
    expect(session.getSnapshot().warning).toBe('')
    expect(native.invoke.mock.calls.some(([name]) => name === 'stop_system_audio_capture')).toBe(true)
  })

  it('still reports a failed translation of a preserved job after a recoverable gap, by showing the original marked as untranslated', async () => {
    const original = native.invoke.getMockImplementation()!
    native.invoke.mockImplementation((name, args) => name === 'cloud_polish' ? Promise.reject(new Error('AI unavailable')) : original(name, args))
    await session.start({ deviceId: 'headphones', targetLanguage: 'ru' })
    frames(20, 0.9)
    frames(15, 0, 0)
    frames(1, 0, 0, undefined, true)
    await settle()

    expect(session.getSnapshot()).toMatchObject({ state: 'listening', caption: 'Original speech', error: '' })
    expect(session.getSnapshot().captionNotice).toContain('not translated')
  })

  it('keeps the gap notice through an empty ASR final until a translated caption succeeds', async () => {
    const original = native.invoke.getMockImplementation()!
    let speech = false
    native.invoke.mockImplementation((name, args) => name === 'local_transcribe' && !speech
      ? Promise.resolve({ text: '', elapsed_ms: 5 }) : original(name, args))
    await session.start({ deviceId: 'headphones', targetLanguage: 'ru' })
    frames(1, 0.9, 88, undefined, true)
    frames(20, 0.9, 77)
    frames(15, 0, 0)
    await settle()

    expect(session.getSnapshot().state).toBe('listening')
    expect(session.getSnapshot().caption).toBe('')
    expect(session.getSnapshot().warning).toContain('listening continues')
    expect(native.invoke.mock.calls.some(([name]) => name === 'cloud_polish')).toBe(false)
    speech = true
    frames(20, 0.9, 99)
    frames(15, 0, 0)
    await settle()
    expect(session.getSnapshot().caption).toBe('Translated speech')
    expect(session.getSnapshot().warning).toBe('')
  })

  describe('two-lane translation pipeline', () => {
    it('starts the next segment ASR while the previous translation is still running and publishes captions in order', async () => {
      numberRecognizedSpeech()
      const pendings: Array<ReturnType<typeof deferred<{ text: string; elapsed_ms: number }>>> = []
      const original = native.invoke.getMockImplementation()!
      native.invoke.mockImplementation((name, args) => {
        if (name === 'cloud_polish') {
          const pending = deferred<{ text: string; elapsed_ms: number }>()
          pendings.push(pending)
          return pending.promise
        }
        return original(name, args)
      })
      let startOptions: StartOptions | undefined
      const provider = new LocalProvider()
      const providerStart = provider.start.bind(provider)
      provider.start = (options) => { startOptions = options; return providerStart(options) }
      session = new SystemAudioSession({
        getProvider: () => provider,
        acquire: async () => { leased = true },
        release: async () => { leased = false },
        overlay,
      })

      await session.start({ deviceId: '', targetLanguage: 'uk' })
      speak()
      await settle()
      expect(polishRequests()).toHaveLength(1)

      speak()
      await settle()

      expect(native.invoke.mock.calls.filter(([name]) => name === 'local_transcribe')).toHaveLength(2)
      expect(polishRequests()).toHaveLength(1)
      expect(startOptions).toMatchObject({ disableAi: true, requireTranslation: true })

      pendings[0].resolve({ text: 'Translation 1', elapsed_ms: 5 })
      await settle()
      expect(session.getSnapshot().caption).toBe('Translation 1')
      expect(polishRequests().map((request) => request.text)).toEqual(['Speech 1', 'Speech 2'])

      pendings[1].resolve({ text: 'Translation 2', elapsed_ms: 5 })
      await settle()
      expect(session.getSnapshot().caption).toBe('Translation 2')
    })

    it('drops the oldest waiting translation instead of accumulating an unbounded backlog', async () => {
      const trace = enablePipelineDebug()
      numberRecognizedSpeech()
      const pendings: Array<ReturnType<typeof deferred<{ text: string; elapsed_ms: number }>>> = []
      const original = native.invoke.getMockImplementation()!
      native.invoke.mockImplementation((name, args) => {
        if (name === 'cloud_polish') {
          const pending = deferred<{ text: string; elapsed_ms: number }>()
          pendings.push(pending)
          return pending.promise
        }
        return original(name, args)
      })
      await session.start({ deviceId: '', targetLanguage: 'uk' })
      const speakLong = () => { frames(125, 0.9); frames(5, 0) }
      for (let index = 0; index < 3; index++) { speakLong(); await settle() }
      expect(session.getSnapshot().state).toBe('listening')

      speakLong()
      await settle()

      expect(session.getSnapshot().state).toBe('listening')
      expect(session.getSnapshot().warning).toContain('behind')
      expect(native.invoke.mock.calls.filter(([name]) => name === 'local_transcribe')).toHaveLength(4)
      expect(trace.getPipelineSnapshot().runs.some((run) => run.status === 'failed'
        && run.reason === 'dropped: translation is behind playback')).toBe(true)

      pendings[0].resolve({ text: 'Translation 1', elapsed_ms: 5 })
      await settle()
      expect(polishRequests().map((request) => request.text)).toEqual(['Speech 1', 'Speech 3'])
    })

    it('drops a translation that resolves after the session was restarted', async () => {
      numberRecognizedSpeech()
      const pendings: Array<ReturnType<typeof deferred<{ text: string; elapsed_ms: number }>>> = []
      const requestIds: unknown[] = []
      const original = native.invoke.getMockImplementation()!
      native.invoke.mockImplementation((name, args) => {
        if (name === 'cloud_polish') {
          const pending = deferred<{ text: string; elapsed_ms: number }>()
          pendings.push(pending)
          requestIds.push((args.request as { request_id?: string }).request_id)
          return pending.promise
        }
        return original(name, args)
      })
      await session.start({ deviceId: '', targetLanguage: 'uk' })
      speak()
      await settle()
      expect(pendings).toHaveLength(1)

      await session.stop()
      await session.start({ deviceId: '', targetLanguage: 'uk' })
      speak()
      await settle()
      expect(pendings).toHaveLength(2)

      emitPolishDelta(requestIds[0], 'Stale partial')
      await settle()
      pendings[0].resolve({ text: 'Stale translation', elapsed_ms: 5 })
      await settle()
      expect(session.getSnapshot().caption).toBe('')
      expect(overlayCalls.some((call) => call.method === 'update' && call.payload.subtitleText === 'Stale partial')).toBe(false)
      expect(overlayCalls.some((call) => call.method === 'update' && call.payload.subtitleText === 'Stale translation')).toBe(false)

      pendings[1].resolve({ text: 'Fresh translation', elapsed_ms: 5 })
      await settle()
      expect(session.getSnapshot().caption).toBe('Fresh translation')
    })

    it('finishes a run once when its translation completes before the ASR run ends', async () => {
      const trace = enablePipelineDebug()
      let callbacks: TranscriptionCallbacks | undefined
      session = new SystemAudioSession({
        getProvider: () => createTestProvider((value) => { callbacks = value }),
        acquire: async () => { leased = true },
        release: async () => { leased = false },
        overlay,
      })
      await session.start({ deviceId: '', targetLanguage: 'ru' })
      frames(20, 0.9)
      frames(15, 0)
      callbacks?.onFinal?.({
        asrText: 'Original speech',
        llmText: '',
        asrMs: 12,
        llmMs: 0,
        durationSec: 0.64,
        aiStatus: 'skipped',
      })
      await settle()
      expect(session.getSnapshot().caption).toBe('Translated speech')

      callbacks?.onDone?.()
      await settle()

      expect(trace.getPipelineSnapshot().runs).toMatchObject([{ status: 'ok', asrMs: 12, llmMs: 5 }])
      expect(trace.getPipelineSnapshot().counters.completed).toBe(1)
      expect(trace.getPipelineSnapshot().counters.failed).toBe(0)
    })

    it('keeps the translation lane alive when the AI settings cannot be read', async () => {
      const original = native.invoke.getMockImplementation()!
      let failSettings = true
      native.invoke.mockImplementation((name, args) => {
        if (name === 'store_get' && args.key === 'cloudAi.provider' && failSettings) {
          return Promise.reject(new Error('store unavailable'))
        }
        return original(name, args)
      })
      await session.start({ deviceId: '', targetLanguage: 'ru' })
      speak()
      await settle()

      expect(session.getSnapshot()).toMatchObject({ state: 'listening', caption: 'Original speech' })
      expect(session.getSnapshot().captionNotice).toContain('not translated')

      failSettings = false
      speak()
      await settle()
      expect(session.getSnapshot().caption).toBe('Translated speech')
    })

    it('shows the translation while the AI is still writing it', async () => {
      let requestId: unknown
      const pending = deferred<{ text: string; elapsed_ms: number }>()
      const original = native.invoke.getMockImplementation()!
      native.invoke.mockImplementation((name, args) => {
        if (name === 'cloud_polish') {
          requestId = (args.request as { request_id?: string }).request_id
          emitPolishDelta(requestId, 'Translated')
          return pending.promise
        }
        return original(name, args)
      })
      await session.start({ deviceId: '', targetLanguage: 'ru' })
      speak()
      await settle()

      expect(session.getSnapshot().caption).toBe('Translated')

      emitPolishDelta(requestId, 'Translated speech')
      await settle()
      expect(session.getSnapshot().caption).toBe('Translated')

      await vi.advanceTimersByTimeAsync(120)
      emitPolishDelta(requestId, 'Translated speech')
      await settle()
      expect(session.getSnapshot().caption).toBe('Translated speech')

      pending.resolve({ text: 'Translated speech', elapsed_ms: 5 })
      await settle()
      expect(session.getSnapshot().caption).toBe('Translated speech')
    })

    it('streams the translation next to the recognized original in dual mode', async () => {
      native.settings.set('systemAudio.dualSubtitles', true)
      let requestId: unknown
      const pending = deferred<{ text: string; elapsed_ms: number }>()
      const original = native.invoke.getMockImplementation()!
      native.invoke.mockImplementation((name, args) => {
        if (name === 'cloud_polish') {
          requestId = (args.request as { request_id?: string }).request_id
          return pending.promise
        }
        return original(name, args)
      })
      await session.start({ deviceId: '', targetLanguage: 'ru' })
      speak()
      await settle()

      emitPolishDelta(requestId, 'Partial translation')
      await settle()
      expect(session.getSnapshot()).toMatchObject({ caption: 'Partial translation', source: 'Original speech' })

      pending.resolve({ text: 'Final translation', elapsed_ms: 5 })
      await settle()
      expect(session.getSnapshot()).toMatchObject({ caption: 'Final translation', source: 'Original speech' })
    })

    it('replaces a partial translation with the recognized original when the stream fails', async () => {
      let requestId: unknown
      const pending = deferred<{ text: string; elapsed_ms: number }>()
      const original = native.invoke.getMockImplementation()!
      native.invoke.mockImplementation((name, args) => {
        if (name === 'cloud_polish') {
          requestId = (args.request as { request_id?: string }).request_id
          return pending.promise
        }
        return original(name, args)
      })
      await session.start({ deviceId: '', targetLanguage: 'ru' })
      speak()
      await settle()

      emitPolishDelta(requestId, 'Partial translation')
      await settle()
      expect(session.getSnapshot().caption).toBe('Partial translation')

      pending.resolve({ text: '', elapsed_ms: 0 })
      await settle()
      expect(session.getSnapshot()).toMatchObject({ state: 'listening', caption: 'Original speech' })
      expect(session.getSnapshot().captionNotice).toContain('not translated')
    })
  })
})
