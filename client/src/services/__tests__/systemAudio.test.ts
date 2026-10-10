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
import { addRuntimeEvent } from '../debugLog'
import { DEEPGRAM_KEYTERM_LIMIT } from '../transcription/types'
import { t } from '@/i18n'
import type {
  LiveAsrCallbacks,
  LiveAsrResult,
  LiveAsrSession,
  StartOptions,
  TranscriptionCallbacks,
  TranscriptionProvider,
} from '../transcription/types'
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

type LiveTestProvider = TranscriptionProvider & {
  openLive: NonNullable<TranscriptionProvider['openLive']>
  closeLive: NonNullable<TranscriptionProvider['closeLive']>
}

interface LiveProviderHarness {
  provider: LiveTestProvider
  callbacks: LiveAsrCallbacks[]
  sessions: LiveAsrSession[]
  sentAudio: Uint8Array[][]
  order: string[]
}

function createLiveProviderHarness(options: {
  open?: (startOptions: StartOptions, callbacks: LiveAsrCallbacks, live: LiveAsrSession) => Promise<LiveAsrSession | null>
  close?: () => Promise<void>
} = {}): LiveProviderHarness {
  const callbacks: LiveAsrCallbacks[] = []
  const sessions: LiveAsrSession[] = []
  const sentAudio: Uint8Array[][] = []
  const order: string[] = []
  let currentSession: LiveAsrSession | undefined
  const provider: LiveTestProvider = {
    ...createTestProvider(() => {}),
    mode: 'cloud_api',
    start: vi.fn(() => true),
    sendAudio: vi.fn(),
    stop: vi.fn(() => true),
    connect: vi.fn(async (value) => {
      order.push('connect')
      value.onReady?.({ asr: true, llm: true })
    }),
    disconnect: vi.fn(() => { order.push('disconnect') }),
    openLive: vi.fn(async (startOptions, liveCallbacks) => {
      order.push('openLive')
      callbacks.push(liveCallbacks)
      const audio: Uint8Array[] = []
      const live: LiveAsrSession = {
        sessionId: `live-${callbacks.length}`,
        sendAudio: vi.fn((buffer) => { audio.push(new Uint8Array(buffer.slice(0))) }),
        finalize: vi.fn(async () => { order.push('finalize') }),
        close: vi.fn(async () => { order.push('live.close'); await options.close?.() }),
      }
      sessions.push(live)
      sentAudio.push(audio)
      currentSession = live
      return options.open ? options.open(startOptions, liveCallbacks, live) : live
    }),
    closeLive: vi.fn(async () => {
      order.push('closeLive')
      await currentSession?.close()
    }),
  }
  return { provider, callbacks, sessions, sentAudio, order }
}

function liveResult(overrides: Partial<LiveAsrResult> = {}): LiveAsrResult {
  return {
    sessionId: 'live-1',
    resultId: 1,
    audioStartMs: 0,
    audioEndMs: 32,
    text: '',
    isFinal: false,
    speechFinal: false,
    fromFinalize: false,
    asrEngine: 'deepgram',
    asrModel: 'nova-3',
    ...overrides,
  }
}

function emitLiveResult(harness: LiveProviderHarness, index: number, overrides: Partial<LiveAsrResult>) {
  const live = harness.sessions[index]
  if (!live) throw new Error(`Missing live session ${index}`)
  harness.callbacks[index]?.onResult(liveResult({ sessionId: live.sessionId, ...overrides }))
}

let overlay: ReturnType<typeof createOverlayPort>

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

async function settle() {
  for (let index = 0; index < 30; index++) await Promise.resolve()
}

let session: SystemAudioSession
let leased = false
let sourceCaptureEndUnixUs = 0
let sourceClockOffsetUs = 0
const sourceFrameSequences = new Map<number, number>()

function enablePipelineDebug() {
  clearPipelineTrace()
  setPipelineDebugEnabled(true)
  return { getPipelineSnapshot }
}

function frames(count: number, probability: number, value = 1, sessionId?: number, discontinuity = false) {
  const started = [...native.invoke.mock.calls].reverse().find(([name]) => name === 'start_system_audio_capture')
  const id = sessionId ?? (started?.[1] as { sessionId: number } | undefined)?.sessionId
  if (!id) throw new Error('Missing native capture session ID')
  for (let index = 0; index < count; index++) {
    deliverFrame(captureFrame(id, probability, value, discontinuity && index === 0))
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

interface CapturedSystemAudioFrame {
  sessionId: number
  audioB64: string
  speechProbability: number
  discontinuity: boolean
  frameSequence: number
  captureStartUnixUs: number
  captureEndUnixUs: number
  captureAnchors: Array<{ audioOffsetSamples: number; captureUnixUs: number }>
}

function captureFrame(sessionId: number, probability: number, value = 1, discontinuity = false): CapturedSystemAudioFrame {
  sourceCaptureEndUnixUs = Math.max(sourceCaptureEndUnixUs, Date.now() * 1_000 + sourceClockOffsetUs)
  const captureStartUnixUs = sourceCaptureEndUnixUs
  sourceCaptureEndUnixUs += 32_000
  const frameSequence = (sourceFrameSequences.get(sessionId) ?? 0) + 1
  sourceFrameSequences.set(sessionId, frameSequence)
  const data = new Int16Array(512).fill(value)
  return {
    sessionId,
    audioB64: uint8ArrayToBase64(new Uint8Array(data.buffer)),
    speechProbability: probability,
    discontinuity,
    frameSequence,
    captureStartUnixUs,
    captureEndUnixUs: sourceCaptureEndUnixUs,
    captureAnchors: [],
  }
}

function deliverFrame(frame: CapturedSystemAudioFrame) {
  native.listeners.get('system-audio-frame')?.({ payload: frame })
}

function emitLiveIdle(payload: {
  sessionId: number
  frameSequence: number
  lastFrameCaptureEndUnixUs: number
  lastAudioCaptureEndUnixUs: number
  confirmedThroughUnixUs: number
}) {
  native.listeners.get('system-audio-live-idle')?.({ payload })
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
  sourceCaptureEndUnixUs = Date.now() * 1_000
  sourceClockOffsetUs = 0
  sourceFrameSequences.clear()
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

  it('keeps the Deepgram keyterm warning across captions without counting a failure and clears it on restart', async () => {
    const trace = enablePipelineDebug()
    let callbacks: TranscriptionCallbacks | undefined
    session = new SystemAudioSession({
      getProvider: () => createTestProvider((value) => { callbacks = value }),
      acquire: async () => { leased = true },
      release: async () => { leased = false },
      overlay,
    })
    const warning = t('asr.deepgramKeytermLimitWarning')

    await session.start({ deviceId: '', targetLanguage: 'ru', asrOnly: true })
    frames(20, 0.9)
    frames(15, 0)
    callbacks?.onWarning?.('deepgram_keyterm_limit')
    expect(session.getSnapshot().warning).toBe(warning)

    callbacks?.onASR?.({ text: 'First recognized caption', asrMs: 5, durationSec: 0.64 })
    callbacks?.onFinal?.({
      asrText: 'First recognized caption',
      llmText: '',
      asrMs: 5,
      llmMs: 0,
      durationSec: 0.64,
      aiStatus: 'skipped',
    })
    callbacks?.onDone?.()
    await settle()

    expect(session.getSnapshot()).toMatchObject({
      state: 'listening',
      caption: 'First recognized caption',
      warning,
      error: '',
    })

    frames(20, 0.9)
    frames(15, 0)
    callbacks?.onASR?.({ text: 'Second recognized caption', asrMs: 5, durationSec: 0.64 })
    callbacks?.onFinal?.({
      asrText: 'Second recognized caption',
      llmText: '',
      asrMs: 5,
      llmMs: 0,
      durationSec: 0.64,
      aiStatus: 'skipped',
    })
    callbacks?.onDone?.()
    await settle()

    expect(session.getSnapshot()).toMatchObject({ caption: 'Second recognized caption', warning })
    expect(trace.getPipelineSnapshot().counters.failed).toBe(0)

    await session.stop()
    expect(session.getSnapshot().warning).toBe('')
    await session.start({ deviceId: '', targetLanguage: 'ru', asrOnly: true })
    expect(session.getSnapshot().warning).toBe('')
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
    expect(native.invoke.mock.calls.filter(([name]) => name === 'stop_system_audio_capture')).toHaveLength(1)
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

  it('shares one pending Stop and does not resume while recorder release is unfinished', async () => {
    const pendingRelease = deferred<void>()
    let releaseCalls = 0
    session = new SystemAudioSession({
      getProvider: () => createTestProvider(() => {}),
      acquire: async () => { leased = true },
      release: async () => { releaseCalls++; await pendingRelease.promise; leased = false },
      overlay,
    })
    await session.start({ deviceId: '', targetLanguage: 'en' })
    let settled = false
    const stopping = session.stop().then(() => { settled = true })
    await settle()
    await vi.advanceTimersByTimeAsync(5_001)
    try {
      expect(settled).toBe(false)
      expect(session.getSnapshot()).toMatchObject({ state: 'stopping', error: t('systemAudio.cleanupUnconfirmed') })
      const resuming = session.resume()
      const secondStop = session.stop()
      await settle()
      expect(releaseCalls).toBe(1)
      expect(native.invoke.mock.calls.filter(([name]) => name === 'start_system_audio_capture')).toHaveLength(1)
      expect(leased).toBe(true)
      pendingRelease.resolve()
      await Promise.all([stopping, secondStop, resuming])
      expect(session.getSnapshot().state).toBe('idle')
      expect(leased).toBe(false)
    } finally {
      pendingRelease.resolve()
      await stopping
    }
  })

  it('keeps the lease until the real cloud provider confirms native close', async () => {
    const pendingSend = deferred<void>()
    const pendingClose = deferred<void>()
    const invoke = native.invoke.getMockImplementation()!
    native.invoke.mockImplementation((name, args) => {
      if (name === 'deepgram_stream_send') return pendingSend.promise
      if (name === 'deepgram_stream_close' && args.sessionId) return pendingClose.promise
      return invoke(name, args)
    })
    native.settings.set('systemAudio.liveRecognitionEnabled', true)
    native.settings.set('cloudAsr.profiles', [{
      id: 'deepgram', provider: 'deepgram', apiKey: 'test-key', model: 'nova-3',
      appId: '', console: 'new', otherKey: '', workspaceId: '', omniPrompt: '',
    }])
    native.settings.set('cloudAsr.activeProfileId', 'deepgram')
    const provider = new CloudAPIProvider()
    session = new SystemAudioSession({
      getProvider: () => provider,
      acquire: async () => { leased = true },
      release: async () => { leased = false },
      overlay,
    })
    await session.start({ deviceId: '', targetLanguage: 'en' })
    expect(session.getSnapshot()).toMatchObject({ state: 'listening', liveRecognition: true })
    frames(1, 0.9)
    await settle()
    let stopped = false
    const stopping = session.stop().then(() => { stopped = true })
    try {
      await vi.advanceTimersByTimeAsync(10_001)
      expect(stopped).toBe(false)
      expect(leased).toBe(true)
      expect(native.invoke.mock.calls.filter(([name]) => name === 'deepgram_stream_close')).toHaveLength(0)
      await session.resume()
      expect(native.invoke.mock.calls.filter(([name]) => name === 'deepgram_stream_open')).toHaveLength(1)
      pendingSend.resolve()
      await settle()
      expect(native.invoke.mock.calls.filter(([name]) => name === 'deepgram_stream_close')).toHaveLength(1)
      expect(stopped).toBe(false)
      expect(leased).toBe(true)
      pendingClose.resolve()
      await stopping
      expect(session.getSnapshot().state).toBe('idle')
      expect(leased).toBe(false)
    } finally {
      pendingSend.resolve()
      pendingClose.resolve()
      await stopping
    }
  })

  it('waits for a hung overlay update and releases the lease once', async () => {
    const pendingUpdate = deferred<void>()
    let updateCalls = 0
    let releaseCalls = 0
    overlay.update = vi.fn((payload: SubtitleOverlayPayload) => {
      overlayCalls.push({ method: 'update', payload })
      return ++updateCalls === 1 ? pendingUpdate.promise : Promise.resolve()
    })
    session = new SystemAudioSession({
      getProvider: () => createTestProvider(() => {}),
      acquire: async () => { leased = true },
      release: async () => { releaseCalls++; leased = false },
      overlay,
    })
    await session.start({ deviceId: '', targetLanguage: 'en' })
    await settle()

    let stopSettled = false
    const stopping = session.stop().finally(() => { stopSettled = true })
    await settle()
    await vi.advanceTimersByTimeAsync(5_001)
    expect(stopSettled).toBe(false)
    expect(session.getSnapshot().state).toBe('stopping')
    expect(leased).toBe(true)

    const sameStop = session.stop()
    pendingUpdate.resolve()
    await Promise.all([stopping, sameStop])
    expect(session.getSnapshot().state).toBe('idle')
    expect(releaseCalls).toBe(1)
  })

  it('reports an overlay update failure and retries only after that update has finished', async () => {
    const pendingUpdate = deferred<void>()
    let updateCalls = 0
    let releaseCalls = 0
    session = new SystemAudioSession({
      getProvider: () => createTestProvider(() => {}),
      acquire: async () => { leased = true },
      release: async () => { releaseCalls++; leased = false },
      overlay,
    })
    await session.start({ deviceId: '', targetLanguage: 'en' })
    await settle()
    overlay.update = vi.fn((payload: SubtitleOverlayPayload) => {
        overlayCalls.push({ method: 'update', payload })
        if (++updateCalls === 1) return pendingUpdate.promise
        return Promise.resolve()
    })

    const stopping = session.stop()
    await settle()
    await vi.advanceTimersByTimeAsync(5_001)
    expect(session.getSnapshot().state).toBe('stopping')
    pendingUpdate.reject(new Error('new overlay update failed'))
    await stopping

    expect(session.getSnapshot().state).toBe('error')
    expect(session.getSnapshot().error).toContain('new overlay update failed')
    expect(leased).toBe(true)
    expect(releaseCalls).toBe(0)
    await session.stop()
    expect(session.getSnapshot().state).toBe('idle')
    expect(releaseCalls).toBe(1)
  })

  it('blocks resume while overlay hide is pending and permits start after confirmed stop', async () => {
    const pendingHide = deferred<void>()
    let hideCalls = 0
    let releaseCalls = 0
    overlay.hide = vi.fn(() => {
      overlayCalls.push({ method: 'hide' })
      return ++hideCalls === 1 ? pendingHide.promise : Promise.resolve()
    })
    session = new SystemAudioSession({
      getProvider: () => createTestProvider(() => {}),
      acquire: async () => { leased = true },
      release: async () => { releaseCalls++; leased = false },
      overlay,
    })
    await session.start({ deviceId: '', targetLanguage: 'en' })

    let stopSettled = false
    const stopping = session.stop().finally(() => { stopSettled = true })
    await settle()
    await vi.advanceTimersByTimeAsync(5_001)
    expect(stopSettled).toBe(false)
    expect(session.getSnapshot().state).toBe('stopping')

    await session.resume()
    expect(session.getSnapshot().state).toBe('stopping')
    expect(leased).toBe(true)
    expect(hideCalls).toBe(1)
    expect(releaseCalls).toBe(0)

    pendingHide.resolve()
    await stopping
    await session.start({ deviceId: '', targetLanguage: 'en' })
    expect(session.getSnapshot().state).toBe('listening')
    expect(leased).toBe(true)
    await session.stop()
    expect(session.getSnapshot().state).toBe('idle')
    expect(releaseCalls).toBe(2)
  })

  it('retries a hung lease release after its first attempt rejects', async () => {
    const pendingRelease = deferred<void>()
    let releaseCalls = 0
    let successfulReleases = 0
    session = new SystemAudioSession({
      getProvider: () => createTestProvider(() => {}),
      acquire: async () => { leased = true },
      release: async () => {
        if (++releaseCalls === 1) await pendingRelease.promise
        if (leased) {
          successfulReleases++
          leased = false
        }
      },
      overlay,
    })
    await session.start({ deviceId: '', targetLanguage: 'en' })

    let stopSettled = false
    const stopping = session.stop().finally(() => { stopSettled = true })
    await settle()
    await vi.advanceTimersByTimeAsync(5_001)
    expect(stopSettled).toBe(false)
    expect(session.getSnapshot().state).toBe('stopping')
    pendingRelease.reject(new Error('first release failed'))
    await stopping
    expect(session.getSnapshot().state).toBe('error')
    expect(leased).toBe(true)
    await session.stop()

    expect(releaseCalls).toBe(2)
    expect(successfulReleases).toBe(1)
    expect(leased).toBe(false)
    expect(session.getSnapshot().state).toBe('idle')
  })

  it('allows stop after a failed overlay update was superseded by a successful update', async () => {
    let updates = 0
    overlay.update = vi.fn(async (payload: SubtitleOverlayPayload) => {
      overlayCalls.push({ method: 'update', payload })
      if (++updates === 1) throw new Error('temporary overlay update failure')
    })
    await session.start({ deviceId: '', targetLanguage: 'en' })
    await settle()
    expect(updates).toBe(1)

    await session.pause()
    await settle()
    expect(updates).toBeGreaterThan(1)

    await session.stop()

    expect(overlayCalls.some((call) => call.method === 'hide')).toBe(true)
    expect(session.getSnapshot().state).toBe('idle')
    expect(leased).toBe(false)
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

  it('retries a failed native capture stop before resuming the batch path', async () => {
    await session.start({ deviceId: '', targetLanguage: 'ru' })
    const original = native.invoke.getMockImplementation()!
    let stopAttempts = 0
    native.invoke.mockImplementation((name, args) => name === 'stop_system_audio_capture' && ++stopAttempts === 1
      ? Promise.reject(new Error('temporary native stop failure'))
      : original(name, args))

    await session.pause()
    expect(session.getSnapshot().state).toBe('error')
    expect(session.getSnapshot().error).toContain('temporary native stop failure')
    expect(leased).toBe(true)

    await session.resume()

    expect(stopAttempts).toBe(2)
    expect(native.invoke.mock.calls.filter(([name]) => name === 'start_system_audio_capture')).toHaveLength(2)
    expect(session.getSnapshot().state).toBe('listening')
    expect(leased).toBe(true)
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

  describe('live recognition', () => {
    function useLiveSession(harness: LiveProviderHarness, asrOnly = false) {
      native.settings.set('systemAudio.liveRecognitionEnabled', true)
      session = new SystemAudioSession({
        getProvider: () => harness.provider,
        acquire: async () => { leased = true },
        release: async () => { harness.order.push('release'); leased = false },
        overlay,
      })
      return session.start({ deviceId: 'speakers', targetLanguage: asrOnly ? '' : 'ru', asrOnly })
    }

    it('keeps live recognition opt-in and preserves the finished-clip path when disabled', async () => {
      const harness = createLiveProviderHarness()
      session = new SystemAudioSession({
        getProvider: () => harness.provider,
        acquire: async () => { leased = true },
        release: async () => { leased = false },
        overlay,
      })

      await session.start({ deviceId: 'speakers', targetLanguage: 'ru' })
      frames(20, 0.9)
      frames(15, 0)
      await settle()

      expect(harness.provider.openLive).not.toHaveBeenCalled()
      expect(session.getSnapshot()).toMatchObject({ state: 'listening', liveOriginal: '', liveRecognition: false })
      expect(harness.provider.start).toHaveBeenCalledTimes(1)
    })

    it('uses batch recognition when an opted-in provider reports live as unsupported', async () => {
      const harness = createLiveProviderHarness({ open: async () => null })
      await useLiveSession(harness)
      frames(20, 0.9)
      frames(15, 0)
      await settle()

      expect(harness.provider.openLive).toHaveBeenCalledTimes(1)
      expect(session.getSnapshot()).toMatchObject({ state: 'listening', liveOriginal: '', liveRecognition: false })
      expect(harness.provider.start).toHaveBeenCalledTimes(1)
      const payload = overlayCalls.find((call) => call.method === 'present')?.payload
      expect(payload).not.toHaveProperty('subtitleLiveRecognition')
      expect(payload).not.toHaveProperty('subtitleLiveText')
    })

    it('opens before capture and sends every frame once while interim revisions replace live text', async () => {
      const harness = createLiveProviderHarness()
      const invoke = native.invoke.getMockImplementation()!
      native.invoke.mockImplementation(async (name, args) => {
        if (name === 'start_system_audio_capture') harness.order.push('start capture')
        return invoke(name, args)
      })
      await useLiveSession(harness)
      frames(1, 0.9, 31)
      frames(1, 0, 32)
      emitLiveResult(harness, 0, { resultId: 1, text: 'First wording', audioEndMs: 32 })
      emitLiveResult(harness, 0, { resultId: 2, text: 'Revised wording', audioEndMs: 64 })
      emitLiveResult(harness, 0, { resultId: 4, text: 'Latest wording', audioEndMs: 64 })
      emitLiveResult(harness, 0, { resultId: 3, text: 'Delayed unseen result', audioEndMs: 64 })
      await settle()

      expect(harness.order.indexOf('openLive')).toBeLessThan(harness.order.findIndex((entry) => entry === 'start capture'))
      expect(harness.sentAudio[0]?.map((audio) => new Int16Array(audio.buffer)[0])).toEqual([31, 32])
      expect(session.getSnapshot()).toMatchObject({ liveRecognition: true, liveOriginal: 'Latest wording' })
      expect(polishRequests()).toHaveLength(0)
      expect(overlayCalls.some((call) => call.method !== 'hide'
        && call.payload.subtitleLiveRecognition === true
        && call.payload.subtitleLiveText === 'Latest wording')).toBe(true)
    })

    it('commits repeated stable words once and preserves an empty boundary without closing a newer phrase', async () => {
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      frames(2, 0.9)
      emitLiveResult(harness, 0, { resultId: 1, audioStartMs: 0, audioEndMs: 32, text: 'go', isFinal: true })
      emitLiveResult(harness, 0, { resultId: 2, audioStartMs: 32, audioEndMs: 64, text: 'go', isFinal: true })
      emitLiveResult(harness, 0, { resultId: 3, audioStartMs: 64, audioEndMs: 64, text: '', speechFinal: true })
      await settle()
      expect(polishRequests().map((request) => request.text)).toEqual(['go go'])

      emitLiveResult(harness, 0, { resultId: 4, audioStartMs: 64, audioEndMs: 80, text: 'next' })
      emitLiveResult(harness, 0, { resultId: 5, audioStartMs: 32, audioEndMs: 64, text: '', speechFinal: true })
      await settle()

      expect(polishRequests().map((request) => request.text)).toEqual(['go go'])
      expect(session.getSnapshot().liveOriginal).toBe('next')
    })

    it.each([
      { kind: 'interim', isFinal: false },
      { kind: 'stable', isFinal: true },
    ])('rejects a $kind range that overlaps the committed phrase boundary', async ({ kind, isFinal }) => {
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      frames(80, 0.9)
      emitLiveResult(harness, 0, { resultId: 1, audioStartMs: 0, audioEndMs: 1_000, text: 'Earlier phrase', isFinal: true })
      emitLiveResult(harness, 0, { resultId: 2, audioStartMs: 1_000, audioEndMs: 2_000, text: '', speechFinal: true })
      emitLiveResult(harness, 0, { resultId: 3, audioStartMs: 1_500, audioEndMs: 2_500, text: `Late old ${kind}`, isFinal })
      await settle()

      expect(session.getSnapshot().liveOriginal).toBe('')
      expect(polishRequests().map((request) => request.text)).toEqual(['Earlier phrase'])
    })

    it('does not publish a stable phrase into the unfinished live region when the same result commits it', async () => {
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      frames(1, 0.9)
      overlayCalls = []
      emitLiveResult(harness, 0, {
        resultId: 1,
        audioStartMs: 0,
        audioEndMs: 32,
        text: 'Committed immediately',
        isFinal: true,
        speechFinal: true,
      })
      await settle()

      expect(session.getSnapshot().liveOriginal).toBe('')
      expect(overlayCalls.filter((call) => call.method === 'update')
        .some((call) => call.payload.subtitleLiveText === 'Committed immediately')).toBe(false)
      expect(polishRequests().map((request) => request.text)).toEqual(['Committed immediately'])
    })

    it('keeps a newer live phrase separate while the previous phrase translation streams', async () => {
      native.settings.set('systemAudio.dualSubtitles', true)
      const pending = deferred<{ text: string; elapsed_ms: number }>()
      const original = native.invoke.getMockImplementation()!
      native.invoke.mockImplementation((name, args) => name === 'cloud_polish' ? pending.promise : original(name, args))
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      frames(2, 0.9)
      emitLiveResult(harness, 0, { resultId: 1, audioStartMs: 0, audioEndMs: 32, text: 'Phrase A', isFinal: true })
      emitLiveResult(harness, 0, { resultId: 2, audioStartMs: 32, audioEndMs: 32, text: '', speechFinal: true })
      await settle()
      const requestId = (polishRequests()[0] as { request_id: string }).request_id
      emitPolishDelta(requestId, 'A translation')
      await settle()

      emitLiveResult(harness, 0, { resultId: 3, audioStartMs: 32, audioEndMs: 64, text: 'Phrase B' })
      await settle()

      expect(session.getSnapshot()).toMatchObject({
        caption: 'A translation',
        source: 'Phrase A',
        liveOriginal: 'Phrase B',
      })
      expect(polishRequests().map((request) => request.text)).toEqual(['Phrase A'])
    })

    it('keeps the previous translation visible while the next phrase translates', async () => {
      const pendings = [deferred<{ text: string; elapsed_ms: number }>(), deferred<{ text: string; elapsed_ms: number }>()]
      let polishCount = 0
      const invoke = native.invoke.getMockImplementation()!
      native.invoke.mockImplementation((name, args) => name === 'cloud_polish' ? pendings[polishCount++].promise : invoke(name, args))
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      frames(2, 0.9)
      emitLiveResult(harness, 0, { resultId: 1, audioStartMs: 0, audioEndMs: 32, text: 'Phrase A', isFinal: true })
      emitLiveResult(harness, 0, { resultId: 2, audioStartMs: 32, audioEndMs: 32, text: '', speechFinal: true })
      await settle()
      const firstRequest = (polishRequests()[0] as { request_id: string }).request_id
      emitPolishDelta(firstRequest, 'A translation')
      pendings[0].resolve({ text: 'A translation', elapsed_ms: 5 })
      await settle()
      expect(session.getSnapshot().caption).toBe('A translation')

      emitLiveResult(harness, 0, { resultId: 3, audioStartMs: 32, audioEndMs: 64, text: 'Phrase B', isFinal: true })
      emitLiveResult(harness, 0, { resultId: 4, audioStartMs: 64, audioEndMs: 64, text: '', speechFinal: true })
      await settle()
      expect(polishRequests()).toHaveLength(2)
      expect(session.getSnapshot().caption).toBe('A translation')

      await vi.advanceTimersByTimeAsync(120)
      const secondRequest = (polishRequests()[1] as { request_id: string }).request_id
      emitPolishDelta(secondRequest, 'B translation')
      await settle()
      expect(session.getSnapshot().caption).toBe('B translation')

      pendings[1].resolve({ text: 'B translation', elapsed_ms: 5 })
      await settle()
      expect(session.getSnapshot().caption).toBe('B translation')
    })

    it('marks a live phrase queue delay when it reaches the shared translation scheduler', async () => {
      const trace = enablePipelineDebug()
      const firstTranslation = deferred<{ text: string; elapsed_ms: number }>()
      const invoke = native.invoke.getMockImplementation()!
      let polishCount = 0
      native.invoke.mockImplementation((name, args) => {
        if (name === 'cloud_polish' && polishCount++ === 0) return firstTranslation.promise
        return invoke(name, args)
      })
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      frames(20, 0.9)
      emitLiveResult(harness, 0, { resultId: 1, audioStartMs: 0, audioEndMs: 320, text: 'Phrase A', isFinal: true })
      emitLiveResult(harness, 0, { resultId: 2, audioStartMs: 320, audioEndMs: 320, text: '', speechFinal: true })
      await settle()
      expect(polishRequests()).toHaveLength(1)

      emitLiveResult(harness, 0, { resultId: 3, audioStartMs: 320, audioEndMs: 640, text: 'Phrase B', isFinal: true })
      emitLiveResult(harness, 0, { resultId: 4, audioStartMs: 640, audioEndMs: 640, text: '', speechFinal: true })
      await vi.advanceTimersByTimeAsync(125)
      firstTranslation.resolve({ text: 'Translation A', elapsed_ms: 5 })
      await settle()

      expect(trace.getPipelineSnapshot().runs.map((run) => ({ text: run.asrChars, queueMs: run.queueMs }))).toEqual([
        { text: 'Phrase A'.length, queueMs: 0 },
        { text: 'Phrase B'.length, queueMs: 125 },
      ])
    })

    it('composes backlog warnings with keyterm and discontinuity warnings through later captions', async () => {
      const firstTranslation = deferred<{ text: string; elapsed_ms: number }>()
      const invoke = native.invoke.getMockImplementation()!
      let polishCount = 0
      native.invoke.mockImplementation((name, args) => {
        if (name === 'cloud_polish' && polishCount++ === 0) return firstTranslation.promise
        return invoke(name, args)
      })
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      frames(1, 0.9, 88, undefined, true)
      await settle()
      expect(harness.provider.openLive).toHaveBeenCalledTimes(2)

      harness.callbacks[1]?.onWarning({
        sessionId: harness.sessions[1]!.sessionId,
        code: DEEPGRAM_KEYTERM_LIMIT,
        asrEngine: 'deepgram',
        asrModel: 'nova-3',
      })
      const captureStarts = native.invoke.mock.calls.filter(([name]) => name === 'start_system_audio_capture')
      const successorCapture = (captureStarts[captureStarts.length - 1]?.[1] as { sessionId: number }).sessionId
      frames(500, 0.9, 1, successorCapture)

      emitLiveResult(harness, 1, { resultId: 1, audioStartMs: 0, audioEndMs: 2_000, text: 'First phrase', isFinal: true })
      emitLiveResult(harness, 1, { resultId: 2, audioStartMs: 2_000, audioEndMs: 2_000, text: '', speechFinal: true })
      await settle()
      expect(polishRequests()).toHaveLength(1)

      emitLiveResult(harness, 1, { resultId: 3, audioStartMs: 2_000, audioEndMs: 9_000, text: 'Second phrase', isFinal: true })
      emitLiveResult(harness, 1, { resultId: 4, audioStartMs: 9_000, audioEndMs: 9_000, text: '', speechFinal: true })
      emitLiveResult(harness, 1, { resultId: 5, audioStartMs: 9_000, audioEndMs: 16_000, text: 'Third phrase', isFinal: true })
      emitLiveResult(harness, 1, { resultId: 6, audioStartMs: 16_000, audioEndMs: 16_000, text: '', speechFinal: true })
      await settle()

      expect(session.getSnapshot().warning).toContain(t('systemAudio.behind'))
      expect(session.getSnapshot().warning).toContain(t('asr.deepgramKeytermLimitWarning'))
      expect(session.getSnapshot().warning).toContain(t('systemAudio.discontinuity'))

      firstTranslation.resolve({ text: 'Translation first', elapsed_ms: 5 })
      await settle()
      expect(session.getSnapshot().warning).toContain(t('asr.deepgramKeytermLimitWarning'))
      expect(session.getSnapshot().warning).toContain(t('systemAudio.discontinuity'))
    })

    it('commits only confirmed prefixes at the source-audio target and ignores a delayed old boundary', async () => {
      native.settings.set('systemAudio.maxSegmentSec', 3)
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      frames(20, 0.9)
      emitLiveResult(harness, 0, { resultId: 1, audioStartMs: 0, audioEndMs: 640, text: 'Confirmed prefix', isFinal: true })
      frames(74, 0)
      await settle()

      expect(harness.sessions[0]?.finalize).toHaveBeenCalledTimes(1)
      expect(polishRequests().map((request) => request.text)).toEqual(['Confirmed prefix'])
      expect(session.getSnapshot().liveOriginal).toBe('')

      emitLiveResult(harness, 0, { resultId: 2, audioStartMs: 640, audioEndMs: 704, text: 'Phrase B' })
      emitLiveResult(harness, 0, { resultId: 3, audioStartMs: 0, audioEndMs: 640, text: '', speechFinal: true })
      await settle()

      expect(session.getSnapshot().liveOriginal).toBe('Phrase B')
      expect(polishRequests().map((request) => request.text)).toEqual(['Confirmed prefix'])
      expect(harness.sessions).toHaveLength(1)
    })

    it('measures target-committed ASR delay from the stable result arrival, not the target timer', async () => {
      const trace = enablePipelineDebug()
      native.settings.set('systemAudio.maxSegmentSec', 3)
      vi.setSystemTime(new Date('2026-10-08T12:00:00.000Z'))
      sourceCaptureEndUnixUs = Date.now() * 1_000
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      frames(1, 0.9)
      await vi.advanceTimersByTimeAsync(100)
      emitLiveResult(harness, 0, { resultId: 1, audioStartMs: 0, audioEndMs: 32, text: 'Confirmed early', isFinal: true })
      frames(92, 0)
      await vi.advanceTimersByTimeAsync(400)
      frames(1, 0)
      await settle()

      expect(trace.getPipelineSnapshot().runs).toMatchObject([{ asrMs: 68, recognitionKind: 'live' }])
    })

    it('requests finalization at the target without promoting an interim or waiting for an acknowledgement', async () => {
      native.settings.set('systemAudio.maxSegmentSec', 3)
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      frames(1, 0.9)
      emitLiveResult(harness, 0, { resultId: 1, audioStartMs: 0, audioEndMs: 32, text: 'Not confirmed' })
      frames(93, 0)
      await settle()

      expect(harness.sessions[0]?.finalize).toHaveBeenCalledTimes(1)
      expect(harness.provider.openLive).toHaveBeenCalledTimes(1)
      expect(session.getSnapshot()).toMatchObject({ state: 'listening', caption: '', liveOriginal: 'Not confirmed' })
      expect(polishRequests()).toHaveLength(0)
    })

    it('rearms the audio target from a delayed phrase boundary instead of the current send frontier', async () => {
      native.settings.set('systemAudio.maxSegmentSec', 3)
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      frames(94, 0.9)
      vi.spyOn(harness.sessions[0]!, 'finalize').mockClear()
      emitLiveResult(harness, 0, { resultId: 1, audioStartMs: 0, audioEndMs: 32, text: 'Phrase A', isFinal: true })
      emitLiveResult(harness, 0, { resultId: 2, audioStartMs: 32, audioEndMs: 32, text: '', speechFinal: true })
      emitLiveResult(harness, 0, { resultId: 3, audioStartMs: 32, audioEndMs: 64, text: 'Continuing speech' })
      frames(1, 0.9)

      expect(harness.sessions[0]?.finalize).toHaveBeenCalledTimes(1)
    })

    it('attributes a delayed finalize result to its request reason and target', async () => {
      const trace = enablePipelineDebug()
      native.settings.set('systemAudio.maxSegmentSec', 3)
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      frames(93, 0.9)
      emitLiveResult(harness, 0, { resultId: 1, audioStartMs: 2_944, audioEndMs: 2_976, text: 'First phrase' })
      frames(1, 0.9)

      const captureId = (native.invoke.mock.calls.find(([name]) => name === 'start_system_audio_capture')?.[1] as { sessionId: number }).sessionId
      const gapFrame = captureFrame(captureId, 0.9)
      deliverFrame(gapFrame)
      emitLiveResult(harness, 0, { resultId: 2, audioStartMs: 2_976, audioEndMs: 3_024, text: 'Following phrase' })
      emitLiveIdle({
        sessionId: captureId,
        frameSequence: gapFrame.frameSequence,
        lastFrameCaptureEndUnixUs: gapFrame.captureEndUnixUs,
        lastAudioCaptureEndUnixUs: gapFrame.captureEndUnixUs,
        confirmedThroughUnixUs: gapFrame.captureEndUnixUs + 512_000,
      })
      expect(harness.sessions[0]?.finalize).toHaveBeenCalledTimes(2)

      emitLiveResult(harness, 0, {
        resultId: 3,
        audioStartMs: 2_944,
        audioEndMs: 2_976,
        text: 'First phrase',
        isFinal: true,
        fromFinalize: true,
      })
      await settle()

      expect(trace.getPipelineSnapshot().runs.map((run) => run.closeReason)).toEqual(['cap'])

      frames(93, 0.9)
      expect(harness.sessions[0]?.finalize).toHaveBeenCalledTimes(3)
    })

    it('does not consume finalize metadata when a stale result fails the committed watermark', async () => {
      const trace = enablePipelineDebug()
      native.settings.set('systemAudio.maxSegmentSec', 3)
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      frames(1, 0.9)
      emitLiveResult(harness, 0, {
        resultId: 1,
        audioStartMs: 0,
        audioEndMs: 32,
        text: 'First phrase',
        isFinal: true,
        speechFinal: true,
      })
      emitLiveResult(harness, 0, { resultId: 2, audioStartMs: 32, audioEndMs: 64, text: 'Next phrase' })
      frames(93, 0.9)
      frames(1, 0.9)
      expect(harness.sessions[0]?.finalize).toHaveBeenCalledTimes(1)

      emitLiveResult(harness, 0, {
        resultId: 3,
        audioStartMs: 0,
        audioEndMs: 32,
        text: 'Stale duplicate',
        isFinal: true,
        fromFinalize: true,
      })

      const captureId = (native.invoke.mock.calls.find(([name]) => name === 'start_system_audio_capture')?.[1] as { sessionId: number }).sessionId
      const gapFrame = captureFrame(captureId, 0.9)
      deliverFrame(gapFrame)
      emitLiveIdle({
        sessionId: captureId,
        frameSequence: gapFrame.frameSequence,
        lastFrameCaptureEndUnixUs: gapFrame.captureEndUnixUs,
        lastAudioCaptureEndUnixUs: gapFrame.captureEndUnixUs,
        confirmedThroughUnixUs: gapFrame.captureEndUnixUs + 512_000,
      })
      expect(harness.sessions[0]?.finalize).toHaveBeenCalledTimes(2)

      emitLiveResult(harness, 0, {
        resultId: 4,
        audioStartMs: 32,
        audioEndMs: 64,
        text: 'Next phrase',
        isFinal: true,
        fromFinalize: true,
      })
      await settle()
      expect(trace.getPipelineSnapshot().runs.map((run) => run.closeReason)).toEqual(['silence', 'cap'])
      expect(polishRequests().map((request) => request.text)).toEqual(['First phrase', 'Next phrase'])

      emitLiveResult(harness, 0, { resultId: 5, audioStartMs: 64, audioEndMs: 80, text: 'Later phrase' })
      frames(93, 0.9)
      await settle()

      expect(harness.sessions[0]?.finalize).toHaveBeenCalledTimes(3)
    })

    it('matches a later finalize after an earlier request produces no result', async () => {
      const trace = enablePipelineDebug()
      native.settings.set('systemAudio.maxSegmentSec', 3)
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      frames(93, 0.9)
      emitLiveResult(harness, 0, { resultId: 1, audioStartMs: 2_944, audioEndMs: 2_976, text: 'Unflushed phrase' })
      frames(1, 0.9)

      const captureId = (native.invoke.mock.calls.find(([name]) => name === 'start_system_audio_capture')?.[1] as { sessionId: number }).sessionId
      const gapFrame = captureFrame(captureId, 0.9)
      deliverFrame(gapFrame)
      emitLiveResult(harness, 0, { resultId: 2, audioStartMs: 3_008, audioEndMs: 3_024, text: 'Later phrase' })
      emitLiveIdle({
        sessionId: captureId,
        frameSequence: gapFrame.frameSequence,
        lastFrameCaptureEndUnixUs: gapFrame.captureEndUnixUs,
        lastAudioCaptureEndUnixUs: gapFrame.captureEndUnixUs,
        confirmedThroughUnixUs: gapFrame.captureEndUnixUs + 512_000,
      })
      expect(harness.sessions[0]?.finalize).toHaveBeenCalledTimes(2)

      emitLiveResult(harness, 0, {
        resultId: 3,
        audioStartMs: 3_008,
        audioEndMs: 3_024,
        text: 'Later phrase',
        isFinal: true,
        fromFinalize: true,
      })
      await settle()

      expect(trace.getPipelineSnapshot().runs.map((run) => run.closeReason)).toEqual(['gap'])
      expect(polishRequests().map((request) => request.text)).toEqual(['Later phrase'])
    })

    it('commits a retired finalize result with the last request metadata', async () => {
      const trace = enablePipelineDebug()
      native.settings.set('systemAudio.maxSegmentSec', 3)
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      frames(1, 0.9)
      emitLiveResult(harness, 0, { resultId: 1, audioStartMs: 0, audioEndMs: 32, text: 'Pending text' })
      const captureId = (native.invoke.mock.calls.find(([name]) => name === 'start_system_audio_capture')?.[1] as { sessionId: number }).sessionId
      for (let index = 0; index < 33; index++) {
        const frame = captureFrame(captureId, 0.9)
        deliverFrame(frame)
        emitLiveIdle({
          sessionId: captureId,
          frameSequence: frame.frameSequence,
          lastFrameCaptureEndUnixUs: frame.captureEndUnixUs,
          lastAudioCaptureEndUnixUs: frame.captureEndUnixUs,
          confirmedThroughUnixUs: frame.captureEndUnixUs + 512_000,
        })
      }
      expect(harness.sessions[0]?.finalize).toHaveBeenCalledTimes(33)

      emitLiveResult(harness, 0, {
        resultId: 2,
        audioStartMs: 0,
        audioEndMs: 32,
        text: 'Late transcript',
        isFinal: true,
        fromFinalize: true,
      })
      await settle()

      expect(session.getSnapshot().liveOriginal).toBe('')
      expect(trace.getPipelineSnapshot().runs.map((run) => run.closeReason)).toEqual(['gap'])
      expect(polishRequests().map((request) => request.text)).toEqual(['Late transcript'])
    })

    it('skips the target flush while no speech is pending and flushes once speech appears', async () => {
      native.settings.set('systemAudio.maxSegmentSec', 3)
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      frames(120, 0)
      await settle()

      expect(harness.sessions[0]?.finalize).not.toHaveBeenCalled()
      expect(session.getSnapshot().state).toBe('listening')

      emitLiveResult(harness, 0, { resultId: 1, audioStartMs: 3_840, audioEndMs: 3_872, text: 'Pending tail' })
      frames(120, 0)
      await settle()

      expect(harness.sessions[0]?.finalize).toHaveBeenCalledTimes(1)
      expect(session.getSnapshot().state).toBe('listening')
    })

    it('flushes an idle tail once per new audio frontier and reuses the live socket', async () => {
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      const captureId = (native.invoke.mock.calls.find(([name]) => name === 'start_system_audio_capture')?.[1] as { sessionId: number }).sessionId
      const first = captureFrame(captureId, 0.9)
      deliverFrame(first)
      emitLiveResult(harness, 0, { resultId: 1, text: 'Unfinished' })
      const firstIdle = {
        sessionId: captureId,
        frameSequence: first.frameSequence,
        lastFrameCaptureEndUnixUs: first.captureEndUnixUs,
        lastAudioCaptureEndUnixUs: first.captureEndUnixUs,
        confirmedThroughUnixUs: first.captureEndUnixUs + 512_000,
      }
      emitLiveIdle(firstIdle)
      await settle()
      expect(harness.sessions[0]?.finalize).toHaveBeenCalledTimes(1)

      const second = captureFrame(captureId, 0)
      deliverFrame(second)
      const secondIdle = {
        sessionId: captureId,
        frameSequence: second.frameSequence,
        lastFrameCaptureEndUnixUs: second.captureEndUnixUs,
        lastAudioCaptureEndUnixUs: second.captureEndUnixUs,
        confirmedThroughUnixUs: second.captureEndUnixUs + 512_000,
      }
      emitLiveIdle(secondIdle)
      await settle()

      expect(harness.sessions[0]?.finalize).toHaveBeenCalledTimes(2)
      expect(harness.provider.openLive).toHaveBeenCalledTimes(1)
      expect(harness.sessions[0]?.close).not.toHaveBeenCalled()
      expect(harness.sentAudio[0]).toHaveLength(2)
    })

    it('does not treat delayed frontend frame delivery as a captured source gap', async () => {
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      const captureId = (native.invoke.mock.calls.find(([name]) => name === 'start_system_audio_capture')?.[1] as { sessionId: number }).sessionId
      const first = captureFrame(captureId, 0.9)
      const second = captureFrame(captureId, 0.9)
      deliverFrame(first)
      await vi.advanceTimersByTimeAsync(700)
      deliverFrame(second)
      await settle()

      expect(harness.provider.openLive).toHaveBeenCalledTimes(1)
      expect(harness.sessions[0]?.finalize).not.toHaveBeenCalled()
      expect(session.getSnapshot().state).toBe('listening')
    })

    it('flushes a phrase only after source-confirmed native idle at the current frontier', async () => {
      native.settings.set('systemAudio.maxSegmentSec', 60)
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      const captureId = (native.invoke.mock.calls.find(([name]) => name === 'start_system_audio_capture')?.[1] as { sessionId: number }).sessionId
      const first = captureFrame(captureId, 0.9)
      deliverFrame(first)
      emitLiveResult(harness, 0, { resultId: 1, audioStartMs: 0, audioEndMs: 32, text: 'Idle phrase' })

      emitLiveIdle({
        sessionId: captureId,
        frameSequence: first.frameSequence,
        lastFrameCaptureEndUnixUs: first.captureEndUnixUs,
        lastAudioCaptureEndUnixUs: first.captureEndUnixUs,
        confirmedThroughUnixUs: first.captureEndUnixUs + 512_000,
      })
      await settle()

      expect(harness.sessions[0]?.finalize).toHaveBeenCalledTimes(1)
      expect(harness.sentAudio[0]).toHaveLength(1)
      expect(harness.provider.openLive).toHaveBeenCalledTimes(1)
    })

    it('ignores delayed and repeated native idle evidence after a newer source frontier', async () => {
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      const captureId = (native.invoke.mock.calls.find(([name]) => name === 'start_system_audio_capture')?.[1] as { sessionId: number }).sessionId
      const first = captureFrame(captureId, 0.9)
      deliverFrame(first)
      emitLiveResult(harness, 0, { resultId: 1, audioStartMs: 0, audioEndMs: 32, text: 'First' })
      const second = captureFrame(captureId, 0.9)
      deliverFrame(second)
      emitLiveResult(harness, 0, { resultId: 2, audioStartMs: 32, audioEndMs: 64, text: 'Second' })

      const idle = {
        sessionId: captureId,
        frameSequence: first.frameSequence,
        lastFrameCaptureEndUnixUs: first.captureEndUnixUs,
        lastAudioCaptureEndUnixUs: first.captureEndUnixUs,
        confirmedThroughUnixUs: first.captureEndUnixUs + 512_000,
      }
      const liveBeforeIdle = session.getSnapshot().liveOriginal
      emitLiveIdle(idle)
      emitLiveIdle(idle)
      await settle()

      expect(harness.sessions[0]?.finalize).not.toHaveBeenCalled()
      expect(session.getSnapshot().liveOriginal).toBe(liveBeforeIdle)
    })

    it('fails the live epoch on malformed active capture timing', async () => {
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      const captureId = (native.invoke.mock.calls.find(([name]) => name === 'start_system_audio_capture')?.[1] as { sessionId: number }).sessionId
      const malformed = { ...captureFrame(captureId, 0.9), captureEndUnixUs: Number.NaN }
      deliverFrame(malformed)
      await settle()

      expect(session.getSnapshot().state).toBe('error')
      expect(session.getSnapshot().error).not.toBe('')
      expect(harness.sessions[0]?.sendAudio).not.toHaveBeenCalled()
    })

    it('surfaces invalid native packet timing even when no complete PCM frame was emitted', async () => {
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      const captureId = (native.invoke.mock.calls.find(([name]) => name === 'start_system_audio_capture')?.[1] as { sessionId: number }).sessionId
      native.listeners.get('system-audio-capture-timing-error')?.({ payload: {
        sessionId: captureId,
        message: 'WASAPI capture timestamp was flagged invalid',
      } })
      await settle()

      expect(session.getSnapshot().state).toBe('error')
      expect(session.getSnapshot().error).toBe(t('systemAudio.captureTimingUnavailable'))
      expect(harness.provider.closeLive).toHaveBeenCalled()
      expect(leased).toBe(true)
    })

    it('shows a visible error instead of trimming an unfinished UTF-8 phrase over 16 KiB', async () => {
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      frames(1, 0.9)
      emitLiveResult(harness, 0, { resultId: 1, text: 'é'.repeat(8_193) })
      await settle()

      expect(session.getSnapshot().state).toBe('error')
      expect(session.getSnapshot().error).toBe(t('systemAudio.livePhraseOverflow'))
      expect(session.getSnapshot().liveOriginal).toBe('')
      expect(polishRequests()).toHaveLength(0)
      expect(harness.provider.closeLive).toHaveBeenCalled()
      expect(leased).toBe(true)

      await session.stop()
      const combinedHarness = createLiveProviderHarness()
      await useLiveSession(combinedHarness)
      frames(2, 0.9)
      emitLiveResult(combinedHarness, 0, { resultId: 1, audioStartMs: 0, audioEndMs: 32, text: 'é'.repeat(8_000), isFinal: true })
      emitLiveResult(combinedHarness, 0, { resultId: 2, audioStartMs: 32, audioEndMs: 64, text: 'a'.repeat(400) })
      await settle()

      expect(session.getSnapshot().state).toBe('error')
      expect(polishRequests()).toHaveLength(0)
    })

    it('localizes a phrase whose capture timing exceeded the retained source-anchor window', async () => {
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      for (let index = 0; index < 66; index++) {
        if (index > 0) sourceCaptureEndUnixUs += 5_000
        frames(1, 0.9)
      }
      emitLiveResult(harness, 0, { resultId: 1, audioStartMs: 0, audioEndMs: 32, text: 'Unmapped phrase', isFinal: true })
      emitLiveResult(harness, 0, { resultId: 2, audioStartMs: 32, audioEndMs: 32, text: '', speechFinal: true })
      await settle()

      expect(session.getSnapshot().state).toBe('error')
      expect(session.getSnapshot().error).toBe(t('systemAudio.liveTimingUnavailable'))
      expect(polishRequests()).toHaveLength(0)
    })

    it('uses captured source gaps for the existing six-second translation-context reset', async () => {
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      frames(10, 0.9)
      emitLiveResult(harness, 0, { resultId: 1, audioStartMs: 0, audioEndMs: 320, text: 'Earlier phrase', isFinal: true })
      emitLiveResult(harness, 0, { resultId: 2, audioStartMs: 320, audioEndMs: 320, text: '', speechFinal: true })
      await settle()

      await vi.advanceTimersByTimeAsync(7_000)
      frames(10, 0.9)
      emitLiveResult(harness, 0, { resultId: 3, audioStartMs: 320, audioEndMs: 640, text: 'Later phrase', isFinal: true })
      emitLiveResult(harness, 0, { resultId: 4, audioStartMs: 640, audioEndMs: 640, text: '', speechFinal: true })
      await settle()

      expect(polishRequests().map((request) => request.text_context)).toEqual([null, null])
    })

    it('maps an idle gap retained inside one native resampled frame into source-time context', async () => {
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      const captureId = (native.invoke.mock.calls.find(([name]) => name === 'start_system_audio_capture')?.[1] as { sessionId: number }).sessionId
      const frame = captureFrame(captureId, 0.9)
      frame.captureAnchors.push({ audioOffsetSamples: 110, captureUnixUs: frame.captureStartUnixUs + 6_106_876 })
      frame.captureEndUnixUs = frame.captureStartUnixUs + 6_132_002
      deliverFrame(frame)
      emitLiveResult(harness, 0, { resultId: 1, audioStartMs: 0, audioEndMs: 6.8, text: 'Before idle', isFinal: true })
      emitLiveResult(harness, 0, { resultId: 2, audioStartMs: 6.8, audioEndMs: 6.875, text: '', speechFinal: true })
      emitLiveResult(harness, 0, { resultId: 3, audioStartMs: 6.875, audioEndMs: 32, text: 'After idle', isFinal: true })
      emitLiveResult(harness, 0, { resultId: 4, audioStartMs: 32, audioEndMs: 32, text: '', speechFinal: true })
      await settle()

      expect(session.getSnapshot().state).toBe('listening')
      expect(polishRequests().map((request) => request.text_context)).toEqual([null, null])
    })

    it('maps the resumed source start/end from a retained 48 kHz partial frame', async () => {
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      const captureId = (native.invoke.mock.calls.find(([name]) => name === 'start_system_audio_capture')?.[1] as { sessionId: number }).sessionId
      const frame = captureFrame(captureId, 0.9)
      frame.captureAnchors.push({ audioOffsetSamples: 200, captureUnixUs: frame.captureStartUnixUs + 6_012_501 })
      frame.captureEndUnixUs = frame.captureStartUnixUs + 6_032_001
      deliverFrame(frame)
      emitLiveResult(harness, 0, { resultId: 1, audioStartMs: 0, audioEndMs: 12.5, text: 'Before 48 kHz idle', isFinal: true })
      emitLiveResult(harness, 0, { resultId: 2, audioStartMs: 12.5, audioEndMs: 12.5, text: '', speechFinal: true })
      emitLiveResult(harness, 0, { resultId: 3, audioStartMs: 12.5, audioEndMs: 32, text: 'After 48 kHz idle', isFinal: true })
      emitLiveResult(harness, 0, { resultId: 4, audioStartMs: 32, audioEndMs: 32, text: '', speechFinal: true })
      await settle()

      expect(session.getSnapshot().state).toBe('listening')
      expect(polishRequests().map((request) => request.text_context)).toEqual([null, null])
    })

    it('keeps the session alive through real engine slew jitter in frame and anchor timing', async () => {
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      const captureId = (native.invoke.mock.calls.find(([name]) => name === 'start_system_audio_capture')?.[1] as { sessionId: number }).sessionId
      const first = captureFrame(captureId, 0.9)
      deliverFrame(first)
      // Measured on physical hardware (2026-10-09): a frame start can regress ~0.6 ms against the
      // previous frame end, and a forward slew leaves a sub-millisecond intra-frame anchor.
      const second = captureFrame(captureId, 0.9)
      second.captureStartUnixUs = first.captureEndUnixUs - 601
      second.captureEndUnixUs = second.captureStartUnixUs + 32_000
      second.captureAnchors.push({ audioOffsetSamples: 110, captureUnixUs: second.captureStartUnixUs + 6_879 })
      deliverFrame(second)
      await settle()

      expect(session.getSnapshot().state).toBe('listening')
      expect(harness.sessions[0]?.sendAudio).toHaveBeenCalledTimes(2)
    })

    it('resets context by captured source time when an older ASR result arrives after the next phrase', async () => {
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      frames(10, 0.9)
      await vi.advanceTimersByTimeAsync(10_000)
      frames(10, 0.9)

      emitLiveResult(harness, 0, { resultId: 1, audioStartMs: 0, audioEndMs: 320, text: 'Earlier source phrase', isFinal: true })
      emitLiveResult(harness, 0, { resultId: 2, audioStartMs: 320, audioEndMs: 320, text: '', speechFinal: true })
      emitLiveResult(harness, 0, { resultId: 3, audioStartMs: 320, audioEndMs: 640, text: 'Later source phrase', isFinal: true })
      emitLiveResult(harness, 0, { resultId: 4, audioStartMs: 640, audioEndMs: 640, text: '', speechFinal: true })
      await settle()

      expect(polishRequests().map((request) => request.text_context)).toEqual([null, null])
    })

    it('keeps overlay delivery bounded to one in-flight and the latest pending snapshot', async () => {
      const pending = deferred<void>()
      const updates: SubtitleOverlayPayload[] = []
      overlay.update = vi.fn((payload: SubtitleOverlayPayload) => {
        updates.push(payload)
        return updates.length === 1 ? pending.promise : Promise.resolve()
      })
      const harness = createLiveProviderHarness()
      try {
        await useLiveSession(harness)
        await settle()
        frames(20, 0.9)
        for (let resultId = 1; resultId <= 20; resultId++) {
          emitLiveResult(harness, 0, { resultId, audioStartMs: 0, audioEndMs: 32, text: `Revision ${resultId}` })
        }
        await settle()

        expect(updates).toHaveLength(1)
        pending.resolve()
        await settle()

        expect(updates).toHaveLength(2)
        expect(updates[1]?.subtitleLiveText).toBe('Revision 20')
      } finally {
        pending.resolve()
      }
    })

    it('rejects live open without falling back and leaves failed-open cleanup reachable', async () => {
      let failClose = true
      const harness = createLiveProviderHarness({
        open: async () => { throw new Error('live handshake failed') },
        close: async () => {
          if (failClose) throw new Error('live owner cleanup failed')
        },
      })
      await useLiveSession(harness)
      await settle()

      expect(session.getSnapshot().state).toBe('error')
      expect(session.getSnapshot().error).toContain('live owner cleanup failed')
      expect(native.invoke.mock.calls.some(([name]) => name === 'start_system_audio_capture')).toBe(false)
      expect(harness.provider.start).not.toHaveBeenCalled()
      expect(harness.provider.disconnect).not.toHaveBeenCalled()
      expect(leased).toBe(true)

      failClose = false
      await session.stop()
      expect(session.getSnapshot().state).toBe('idle')
      expect(leased).toBe(false)
    })

    it('waits for live close before disconnecting or opening a resumed epoch', async () => {
      const close = deferred<void>()
      const harness = createLiveProviderHarness({ close: () => close.promise })
      await useLiveSession(harness)
      const pausing = session.pause()
      await settle()
      const resuming = session.resume()
      await settle()

      expect(harness.provider.openLive).toHaveBeenCalledTimes(1)
      expect(harness.provider.disconnect).not.toHaveBeenCalled()
      expect(leased).toBe(true)

      close.resolve()
      await Promise.all([pausing, resuming])
      expect(harness.provider.openLive).toHaveBeenCalledTimes(2)
      expect(harness.order.indexOf('closeLive')).toBeLessThan(harness.order.lastIndexOf('disconnect'))
    })

    it('does not open a resumed epoch when Stop supersedes Resume during live close', async () => {
      const closing = deferred<void>()
      const harness = createLiveProviderHarness({ close: () => closing.promise })
      await useLiveSession(harness)
      const pausing = session.pause()
      await settle()
      const resuming = session.resume()
      const stopping = session.stop()
      closing.resolve()
      await Promise.all([pausing, resuming, stopping])
      expect(session.getSnapshot().state).toBe('idle')
      expect(leased).toBe(false)
      expect(harness.provider.openLive).toHaveBeenCalledTimes(1)
      expect(native.invoke.mock.calls.filter(([name]) => name === 'start_system_audio_capture')).toHaveLength(1)
    })

    it('retries each Resume after its previous live cleanup has actually failed', async () => {
      let attempts = 0
      const harness = createLiveProviderHarness({ close: async () => {
        if (++attempts < 3) throw new Error('live close failed')
      } })
      await useLiveSession(harness)
      await session.pause()
      expect(session.getSnapshot().state).toBe('error')
      await session.resume()
      expect(session.getSnapshot().state).toBe('error')
      expect(harness.provider.openLive).toHaveBeenCalledTimes(1)
      await session.resume()
      expect(session.getSnapshot()).toMatchObject({ state: 'listening', liveRecognition: true, error: '' })
      expect(harness.provider.openLive).toHaveBeenCalledTimes(2)
    })

    it('cancels live open but retains the lease until startup has settled', async () => {
      const opening = deferred<LiveAsrSession | null>()
      const harness = createLiveProviderHarness({ open: () => opening.promise })
      const starting = useLiveSession(harness)
      let startupSettled = false
      void starting.then(() => { startupSettled = true })
      await settle()
      expect(harness.provider.openLive).toHaveBeenCalledTimes(1)

      let stopSettled = false
      const stopping = session.stop().then(() => { stopSettled = true })
      await vi.advanceTimersByTimeAsync(5_001)

      expect(startupSettled).toBe(false)
      expect(stopSettled).toBe(false)
      expect(session.getSnapshot().state).toBe('stopping')
      expect(leased).toBe(true)
      expect(native.invoke.mock.calls.some(([name]) => name === 'start_system_audio_capture')).toBe(false)
      expect(harness.provider.closeLive).toHaveBeenCalled()

      opening.resolve(null)
      await Promise.all([starting, stopping])
      expect(session.getSnapshot().state).toBe('idle')
      expect(leased).toBe(false)
    })

    it('joins a pending live close instead of creating another attempt after the watchdog', async () => {
      const stalledClose = deferred<void>()
      let closeCalls = 0
      const harness = createLiveProviderHarness({ close: async () => {
        closeCalls++
        await stalledClose.promise
      } })
      await useLiveSession(harness)

      const stopping = session.stop()
      await vi.advanceTimersByTimeAsync(5_001)

      expect(closeCalls).toBe(1)
      expect(session.getSnapshot().error).toBe(t('systemAudio.cleanupUnconfirmed'))
      expect(leased).toBe(true)

      const sameStop = session.stop()
      await settle()
      expect(closeCalls).toBe(1)
      expect(session.getSnapshot().state).toBe('stopping')
      stalledClose.resolve()
      await Promise.all([stopping, sameStop])

      expect(closeCalls).toBe(1)
      expect(session.getSnapshot().state).toBe('idle')
      expect(leased).toBe(false)

      const disconnectsAfterRetry = harness.order.filter((event) => event === 'disconnect').length
      await useLiveSession(harness)
      await settle()
      expect(harness.order.filter((event) => event === 'disconnect').length).toBe(disconnectsAfterRetry)
      expect(session.getSnapshot()).toMatchObject({ state: 'listening', liveRecognition: true })
      expect(leased).toBe(true)
    })

    it('finishes the old recorder release before a new session can install provider callbacks', async () => {
      const pendingRelease = deferred<void>()
      const harness = createLiveProviderHarness()
      const connectedCallbacks: TranscriptionCallbacks[] = []
      let activeCallbacks: TranscriptionCallbacks | undefined
      let releaseCallbacks: TranscriptionCallbacks | undefined
      let releaseCalls = 0
      const connect = harness.provider.connect.bind(harness.provider)
      harness.provider.connect = vi.fn(async (callbacks) => {
        connectedCallbacks.push(callbacks)
        activeCallbacks = callbacks
        await connect(callbacks)
      })
      session = new SystemAudioSession({
        getProvider: () => harness.provider,
        acquire: async () => { if (leased) throw new Error('Recorder busy'); leased = true },
        release: async () => {
          leased = false
          if (++releaseCalls === 1) {
            await pendingRelease.promise
            await harness.provider.connect(releaseCallbacks!)
          }
        },
        overlay,
      })
      native.settings.set('systemAudio.liveRecognitionEnabled', true)
      await session.start({ deviceId: 'speakers', targetLanguage: 'ru' })
      releaseCallbacks = { ...connectedCallbacks[0]! }

      const stopping = session.stop()
      await settle()
      await vi.advanceTimersByTimeAsync(5_001)

      expect(session.getSnapshot().state).toBe('stopping')
      expect(session.getSnapshot().error).toBe(t('systemAudio.cleanupUnconfirmed'))
      expect(leased).toBe(false)

      await session.resume()
      expect(harness.provider.openLive).toHaveBeenCalledTimes(1)

      pendingRelease.resolve()
      await stopping
      expect(session.getSnapshot().state).toBe('idle')
      await session.start({ deviceId: 'speakers', targetLanguage: 'ru' })

      expect(connectedCallbacks).toHaveLength(3)
      expect(activeCallbacks).toBe(connectedCallbacks[2])
      expect(activeCallbacks).not.toBe(releaseCallbacks)
      expect(session.getSnapshot()).toMatchObject({ state: 'listening', liveRecognition: true, error: '' })
      expect(leased).toBe(true)
      expect(harness.provider.openLive).toHaveBeenCalledTimes(2)
    })

    it('keeps live Pause pending and resumes only after the same stop completes', async () => {
      const nativeStop = deferred<void>()
      const invoke = native.invoke.getMockImplementation()!
      native.invoke.mockImplementation((name, args) => name === 'stop_system_audio_capture' ? nativeStop.promise : invoke(name, args))
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      let pauseSettled = false
      const pausing = session.pause().finally(() => { pauseSettled = true })
      await settle()
      await vi.advanceTimersByTimeAsync(5_001)
      await settle()
      const settledAtWatchdog = pauseSettled
      const watchdogSnapshot = session.getSnapshot()
      const stopCallsAtWatchdog = native.invoke.mock.calls.filter(([name]) => name === 'stop_system_audio_capture').length

      const resuming = session.resume()
      await settle()
      expect(native.invoke.mock.calls.filter(([name]) => name === 'start_system_audio_capture')).toHaveLength(1)
      expect(leased).toBe(true)

      nativeStop.resolve()
      await Promise.all([pausing, resuming])

      expect(settledAtWatchdog).toBe(false)
      expect(watchdogSnapshot.state).toBe('paused')
      expect(watchdogSnapshot.error).toBe(t('systemAudio.cleanupUnconfirmed'))
      expect(stopCallsAtWatchdog).toBe(1)
      expect(session.getSnapshot().state).toBe('listening')
      expect(harness.provider.openLive).toHaveBeenCalledTimes(2)
      expect(native.invoke.mock.calls.filter(([name]) => name === 'start_system_audio_capture')).toHaveLength(2)
      await session.stop()
    })

    it.each(['pause', 'error'] as const)('removes the temporary delay diagnostic after %s cleanup succeeds', async (action) => {
      const closing = deferred<void>()
      const harness = createLiveProviderHarness({ close: () => closing.promise })
      await useLiveSession(harness)
      const pausing = action === 'pause' ? session.pause() : Promise.resolve()
      if (action === 'error') {
        harness.callbacks[0]!.onError({
          sessionId: harness.sessions[0]!.sessionId, message: 'Recognition failed',
          asrEngine: 'deepgram', asrModel: 'nova-3',
        })
      }
      await vi.advanceTimersByTimeAsync(5_001)
      expect(session.getSnapshot().error).toBe(t('systemAudio.cleanupUnconfirmed'))
      closing.resolve()
      await pausing
      await settle()
      expect(session.getSnapshot()).toMatchObject({
        state: action === 'pause' ? 'paused' : 'error',
        error: action === 'pause' ? '' : 'Recognition failed',
      })
      expect(leased).toBe(true)
    })

    it('starts the watchdog before a pending native start response after timing failure', async () => {
      const nativeStart = deferred<void>()
      const nativeStop = deferred<void>()
      const invoke = native.invoke.getMockImplementation()!
      native.invoke.mockImplementation((name, args) => {
        if (name === 'start_system_audio_capture') return nativeStart.promise
        if (name === 'stop_system_audio_capture') return nativeStop.promise
        return invoke(name, args)
      })
      const harness = createLiveProviderHarness()
      const starting = useLiveSession(harness)
      await settle()
      const captureId = (native.invoke.mock.calls.find(([name]) => name === 'start_system_audio_capture')?.[1] as { sessionId: number }).sessionId
      native.listeners.get('system-audio-capture-timing-error')?.({ payload: {
        sessionId: captureId,
        message: 'WASAPI capture timestamp was flagged invalid',
      } })
      await settle()

      let stopSettled = false
      const stopping = session.stop().finally(() => { stopSettled = true })
      await vi.advanceTimersByTimeAsync(5_001)
      await settle()
      const settledAtWatchdog = stopSettled
      const watchdogSnapshot = session.getSnapshot()
      const stopCallsBeforeStartResponse = native.invoke.mock.calls.filter(([name]) => name === 'stop_system_audio_capture').length

      nativeStart.resolve()
      await settle()
      const stopCallsAfterStartResponse = native.invoke.mock.calls.filter(([name]) => name === 'stop_system_audio_capture').length
      nativeStop.resolve()
      await Promise.all([starting, stopping])
      await settle()

      expect(settledAtWatchdog).toBe(false)
      expect(watchdogSnapshot.state).toBe('stopping')
      expect(watchdogSnapshot.error).toBe(t('systemAudio.cleanupUnconfirmed'))
      expect(stopCallsBeforeStartResponse).toBe(0)
      expect(stopCallsAfterStartResponse).toBe(1)
      expect(native.invoke.mock.calls.filter(([name]) => name === 'stop_system_audio_capture')).toHaveLength(1)
      expect(native.invoke.mock.calls.filter(([name]) => name === 'start_system_audio_capture')).toHaveLength(1)
      expect(harness.provider.disconnect).toHaveBeenCalledTimes(1)
      expect(session.getSnapshot().state).toBe('idle')
      expect(leased).toBe(false)
    })

    it('watchdogs Stop while the original native start is pending and stops that capture exactly once', async () => {
      const nativeStart = deferred<void>()
      const nativeStop = deferred<void>()
      const invoke = native.invoke.getMockImplementation()!
      native.invoke.mockImplementation((name, args) => {
        if (name === 'start_system_audio_capture') return nativeStart.promise
        if (name === 'stop_system_audio_capture') return nativeStop.promise
        return invoke(name, args)
      })
      const harness = createLiveProviderHarness()
      const starting = useLiveSession(harness)
      await settle()
      let stopSettled = false
      const stopping = session.stop().finally(() => { stopSettled = true })
      await vi.advanceTimersByTimeAsync(5_001)
      await settle()
      const settledAtWatchdog = stopSettled
      const watchdogSnapshot = session.getSnapshot()
      expect(native.invoke.mock.calls.filter(([name]) => name === 'stop_system_audio_capture')).toHaveLength(0)
      expect(harness.provider.disconnect).not.toHaveBeenCalled()
      expect(leased).toBe(true)

      nativeStart.resolve()
      await settle()
      const stopCallsAfterStartResponse = native.invoke.mock.calls.filter(([name]) => name === 'stop_system_audio_capture').length
      expect(stopCallsAfterStartResponse).toBe(1)
      expect(harness.provider.disconnect).not.toHaveBeenCalled()
      expect(leased).toBe(true)

      nativeStop.resolve()
      await Promise.all([starting, stopping])
      await settle()

      expect(settledAtWatchdog).toBe(false)
      expect(watchdogSnapshot.state).toBe('stopping')
      expect(watchdogSnapshot.error).toBe(t('systemAudio.cleanupUnconfirmed'))
      expect(native.invoke.mock.calls.filter(([name]) => name === 'start_system_audio_capture')).toHaveLength(1)
      expect(native.invoke.mock.calls.filter(([name]) => name === 'stop_system_audio_capture')).toHaveLength(1)
      expect(harness.provider.disconnect).toHaveBeenCalledTimes(1)
      expect(session.getSnapshot().state).toBe('idle')
      expect(leased).toBe(false)
    })

    it('retries after a live capture stop watchdog without duplicating the pending stop', async () => {
      const nativeStop = deferred<void>()
      const invoke = native.invoke.getMockImplementation()!
      native.invoke.mockImplementation((name, args) => name === 'stop_system_audio_capture' ? nativeStop.promise : invoke(name, args))
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      let stopSettled = false
      const stopping = session.stop().finally(() => { stopSettled = true })
      await settle()
      await vi.advanceTimersByTimeAsync(5_001)
      await settle()

      const watchdogSnapshot = session.getSnapshot()
      const stopCallsAtWatchdog = native.invoke.mock.calls.filter(([name]) => name === 'stop_system_audio_capture').length
      const retrying = session.stop()
      await settle()
      expect(native.invoke.mock.calls.filter(([name]) => name === 'stop_system_audio_capture')).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(5_001)
      await settle()
      expect(stopSettled).toBe(false)
      expect(watchdogSnapshot.state).toBe('stopping')
      expect(watchdogSnapshot.error).toBe(t('systemAudio.cleanupUnconfirmed'))
      expect(stopCallsAtWatchdog).toBe(1)
      expect(native.invoke.mock.calls.filter(([name]) => name === 'stop_system_audio_capture')).toHaveLength(1)
      expect(native.invoke.mock.calls.filter(([name]) => name === 'start_system_audio_capture')).toHaveLength(1)
      expect(harness.provider.disconnect).not.toHaveBeenCalled()
      expect(leased).toBe(true)

      nativeStop.resolve()
      await Promise.all([stopping, retrying])
      await settle()

      expect(session.getSnapshot().state).toBe('idle')
      expect(leased).toBe(false)
      expect(native.invoke.mock.calls.filter(([name]) => name === 'stop_system_audio_capture')).toHaveLength(1)
    })

    it('retries a rejected live stop after preserving the capture lease and capture ID', async () => {
      const retryStop = deferred<void>()
      let attempts = 0
      const invoke = native.invoke.getMockImplementation()!
      native.invoke.mockImplementation((name, args) => {
        if (name === 'stop_system_audio_capture') {
          attempts++
          if (attempts === 1) return Promise.reject(new Error('stop IPC failed'))
          return retryStop.promise
        }
        return invoke(name, args)
      })
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      await session.stop()

      expect(session.getSnapshot().state).toBe('error')
      expect(session.getSnapshot().error).toContain('stop IPC failed')
      expect(leased).toBe(true)

      let stopSettled = false
      const retrying = session.stop().finally(() => { stopSettled = true })
      await settle()
      await vi.advanceTimersByTimeAsync(5_001)
      await settle()
      const settledAtWatchdog = stopSettled
      const watchdogSnapshot = session.getSnapshot()
      const stopCallsAtWatchdog = native.invoke.mock.calls.filter(([name]) => name === 'stop_system_audio_capture').length

      retryStop.resolve()
      await retrying
      await settle()

      expect(settledAtWatchdog).toBe(false)
      expect(watchdogSnapshot.state).toBe('stopping')
      expect(watchdogSnapshot.error).toBe(t('systemAudio.cleanupUnconfirmed'))
      expect(stopCallsAtWatchdog).toBe(2)
      expect(session.getSnapshot().state).toBe('idle')
      expect(leased).toBe(false)
      expect(native.invoke.mock.calls.filter(([name]) => name === 'stop_system_audio_capture')).toHaveLength(2)
    })

    it('surfaces live provider and Finalize failures without network recovery', async () => {
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      const current = harness.sessions[0]!
      current.finalize = vi.fn(async () => { throw new Error('Finalize failed') })
      const captureId = (native.invoke.mock.calls.find(([name]) => name === 'start_system_audio_capture')?.[1] as { sessionId: number }).sessionId
      const frame = captureFrame(captureId, 0.9)
      deliverFrame(frame)
      emitLiveIdle({
        sessionId: captureId,
        frameSequence: frame.frameSequence,
        lastFrameCaptureEndUnixUs: frame.captureEndUnixUs,
        lastAudioCaptureEndUnixUs: frame.captureEndUnixUs,
        confirmedThroughUnixUs: frame.captureEndUnixUs + 512_000,
      })
      await settle()

      expect(session.getSnapshot().state).toBe('error')
      expect(session.getSnapshot().error).toContain('Finalize failed')
      expect(harness.provider.openLive).toHaveBeenCalledTimes(1)
      expect(harness.provider.closeLive).toHaveBeenCalled()
    })

    it('surfaces a synchronous PCM send failure and does not fall back to batch recognition', async () => {
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      harness.sessions[0]!.sendAudio = vi.fn(() => { throw new Error('PCM send failed') })
      frames(1, 0.9)
      await settle()

      expect(session.getSnapshot().state).toBe('error')
      expect(session.getSnapshot().error).toContain('PCM send failed')
      expect(harness.provider.openLive).toHaveBeenCalledTimes(1)
      expect(harness.provider.start).not.toHaveBeenCalled()
      expect(harness.provider.closeLive).toHaveBeenCalled()
      expect(leased).toBe(true)
    })

    it('preserves the live ASR hint warning through display and a provider interruption', async () => {
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      const sessionId = harness.sessions[0]!.sessionId
      harness.callbacks[0]?.onWarning({
        sessionId,
        code: DEEPGRAM_KEYTERM_LIMIT,
        asrEngine: 'deepgram',
        asrModel: 'nova-3',
      })
      const warning = session.getSnapshot().warning
      frames(1, 0.9)
      emitLiveResult(harness, 0, { resultId: 1, text: 'Current phrase' })
      harness.callbacks[0]?.onError({ sessionId, message: 'live provider failed', asrEngine: 'deepgram', asrModel: 'nova-3' })
      await settle()

      expect(warning).not.toBe('')
      expect(session.getSnapshot()).toMatchObject({ state: 'error', warning })
      expect(harness.provider.openLive).toHaveBeenCalledTimes(1)
    })

    it('reports phrase ASR delay from captured source end separately from translation timing', async () => {
      const trace = enablePipelineDebug()
      vi.setSystemTime(new Date('2026-10-08T12:00:00.000Z'))
      sourceClockOffsetUs = -320_000
      sourceCaptureEndUnixUs = Date.now() * 1_000 + sourceClockOffsetUs
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      frames(10, 0.9)
      await vi.advanceTimersByTimeAsync(180)
      emitLiveResult(harness, 0, { resultId: 1, audioStartMs: 0, audioEndMs: 320, text: 'Timed phrase', isFinal: true })
      emitLiveResult(harness, 0, { resultId: 2, audioStartMs: 320, audioEndMs: 640, text: '', speechFinal: true })
      await settle()

      expect(trace.getPipelineSnapshot().runs).toMatchObject([{
        recognitionKind: 'live',
        asrMs: 180,
        llmMs: 5,
      }])
    })

    it('awaits live close after stop invalidates a pending open and never starts capture late', async () => {
      const opening = deferred<LiveAsrSession | null>()
      const close = deferred<void>()
      const harness = createLiveProviderHarness({
        open: async (_options, _callbacks, live) => {
          await opening.promise
          return live
        },
        close: () => close.promise,
      })
      const starting = useLiveSession(harness)
      await settle()
      expect(harness.provider.openLive).toHaveBeenCalledTimes(1)

      const stopping = session.stop()
      opening.resolve(harness.sessions[0]!)
      await settle()

      expect(native.invoke.mock.calls.some(([name]) => name === 'start_system_audio_capture')).toBe(false)
      expect(leased).toBe(true)
      expect(harness.provider.disconnect).not.toHaveBeenCalled()

      close.resolve()
      await Promise.all([starting, stopping])

      expect(harness.order.indexOf('closeLive')).toBeLessThan(harness.order.indexOf('disconnect'))
      expect(harness.order.indexOf('disconnect')).toBeLessThan(harness.order.indexOf('release'))
      expect(leased).toBe(false)
    })

    it('keeps the lease and actual cleanup error when live close fails, then allows stop to retry', async () => {
      let failClose = true
      const harness = createLiveProviderHarness({ close: async () => {
        if (failClose) throw new Error('live close unavailable')
      } })
      await useLiveSession(harness)
      await session.stop()

      expect(session.getSnapshot().state).toBe('error')
      expect(session.getSnapshot().error).toContain('live close unavailable')
      expect(leased).toBe(true)

      failClose = false
      await session.stop()
      expect(session.getSnapshot().state).toBe('idle')
      expect(leased).toBe(false)
      expect(native.invoke.mock.calls.filter(([name]) => name === 'stop_system_audio_capture')).toHaveLength(1)
    })

    it('retries failed live cleanup before resuming the capture session', async () => {
      let failClose = true
      const harness = createLiveProviderHarness({ close: async () => {
        if (failClose) throw new Error('live close unavailable')
      } })
      await useLiveSession(harness)
      await session.pause()

      expect(session.getSnapshot().state).toBe('error')
      expect(session.getSnapshot().error).toContain('live close unavailable')
      expect(leased).toBe(true)

      const closeAttemptsBeforeResume = harness.order.filter((event) => event === 'closeLive').length
      failClose = false
      await session.resume()

      expect(harness.order.filter((event) => event === 'closeLive').length).toBeGreaterThan(closeAttemptsBeforeResume)
      expect(harness.provider.openLive).toHaveBeenCalledTimes(2)
      expect(native.invoke.mock.calls.filter(([name]) => name === 'start_system_audio_capture')).toHaveLength(2)
      expect(session.getSnapshot().state).toBe('listening')
      expect(leased).toBe(true)
    })

    it('clears live snapshot state when live close succeeds but capture stop fails', async () => {
      const original = native.invoke.getMockImplementation()!
      let failStop = true
      native.invoke.mockImplementation((name, args) => name === 'stop_system_audio_capture' && failStop
        ? Promise.reject(new Error('temporary native stop failure'))
        : original(name, args))
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)

      await session.pause()

      expect(session.getSnapshot()).toMatchObject({
        state: 'error',
        liveRecognition: false,
        liveOriginal: '',
      })
      expect(session.getSnapshot().error).toContain('temporary native stop failure')
      expect(harness.sessions[0]?.close).toHaveBeenCalled()
      expect(leased).toBe(true)

      failStop = false
      await session.stop()
      expect(session.getSnapshot().state).toBe('idle')
      expect(leased).toBe(false)
    })

    it('uses the provider owner for cleanup without redundantly closing the live handle', async () => {
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      harness.sessions[0]!.close = vi.fn(async () => { throw new Error('inner live close failed') })
      harness.provider.closeLive = vi.fn(async () => { harness.order.push('provider close succeeded') })
      vi.mocked(addRuntimeEvent).mockClear()

      await session.stop()

      expect(session.getSnapshot()).toMatchObject({ state: 'idle', liveRecognition: false, liveOriginal: '' })
      expect(leased).toBe(false)
      expect(harness.provider.disconnect).toHaveBeenCalled()
      expect(harness.sessions[0]!.close).not.toHaveBeenCalled()
      expect(harness.provider.closeLive).toHaveBeenCalledTimes(1)
    })

    it('does not let an old live callback publish into a resumed epoch', async () => {
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      const oldId = harness.sessions[0]?.sessionId
      await session.pause()
      await session.resume()
      frames(1, 0.9)
      emitLiveResult(harness, 0, { resultId: 1, text: 'Stale original' })
      emitLiveResult(harness, 1, { resultId: 1, text: 'Current original' })
      await settle()

      expect(oldId).toBe('live-1')
      expect(session.getSnapshot().liveOriginal).toBe('Current original')
      expect(harness.provider.openLive).toHaveBeenCalledTimes(2)
    })

    it('fences a discontinuous capture before opening a clean successor stream', async () => {
      const harness = createLiveProviderHarness()
      await useLiveSession(harness)
      frames(1, 0.9, 88, undefined, true)
      await settle()

      expect(harness.provider.openLive).toHaveBeenCalledTimes(2)
      expect(native.invoke.mock.calls.filter(([name]) => name === 'stop_system_audio_capture')).toHaveLength(1)
      expect(harness.order.indexOf('live.close')).toBeLessThan(harness.order.lastIndexOf('openLive'))
      expect(session.getSnapshot()).toMatchObject({ state: 'listening', liveRecognition: true })
      expect(session.getSnapshot().warning).toContain('audio gap')
      expect(harness.sentAudio[0]).toHaveLength(0)

      frames(1, 0.9, 99)
      expect(harness.sentAudio[1]).toHaveLength(1)
    })

    it('localizes a missing discontinuity successor while retaining diagnostic detail', async () => {
      let openCount = 0
      const harness = createLiveProviderHarness({
        open: async (_options, _callbacks, live) => ++openCount === 1 ? live : null,
      })
      await useLiveSession(harness)
      frames(1, 0.9, 88, undefined, true)
      await settle()

      expect(session.getSnapshot().state).toBe('error')
      expect(session.getSnapshot().error).toBe(t('systemAudio.notReady'))
    })

    it('does not open a discontinuity successor when native capture fencing fails', async () => {
      const harness = createLiveProviderHarness()
      const invoke = native.invoke.getMockImplementation()!
      native.invoke.mockImplementation((name, args) => name === 'stop_system_audio_capture'
        ? Promise.reject(new Error('native fence failed'))
        : invoke(name, args))
      await useLiveSession(harness)
      frames(1, 0.9, 88, undefined, true)
      await settle()

      expect(harness.provider.openLive).toHaveBeenCalledTimes(1)
      expect(session.getSnapshot()).toMatchObject({ state: 'error', liveRecognition: false, liveOriginal: '' })
      expect(session.getSnapshot().error).toContain('native fence failed')
      expect(session.getSnapshot().warning).toContain('audio gap')
      expect(leased).toBe(true)

      native.invoke.mockImplementation(invoke)
      await session.stop()
      expect(leased).toBe(false)
    })

    it('keeps recognition-only live text current and moves each confirmed phrase once', async () => {
      const harness = createLiveProviderHarness()
      await useLiveSession(harness, true)
      frames(2, 0.9)
      emitLiveResult(harness, 0, { resultId: 1, audioStartMs: 0, audioEndMs: 32, text: 'First', isFinal: true })
      emitLiveResult(harness, 0, { resultId: 2, audioStartMs: 32, audioEndMs: 32, text: '', speechFinal: true })
      emitLiveResult(harness, 0, { resultId: 3, audioStartMs: 32, audioEndMs: 64, text: 'Current' })
      await settle()

      expect(session.getSnapshot()).toMatchObject({ caption: 'First', liveOriginal: 'Current', source: '' })
      expect(polishRequests()).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(8_000)
      expect(session.getSnapshot()).toMatchObject({ caption: '', liveOriginal: 'Current' })
    })

    it('moves recognition-only text from live to settled in one snapshot', async () => {
      const harness = createLiveProviderHarness()
      await useLiveSession(harness, true)
      frames(1, 0.9)
      emitLiveResult(harness, 0, { resultId: 1, audioStartMs: 0, audioEndMs: 32, text: 'Settled original' })
      await settle()
      overlayCalls = []
      emitLiveResult(harness, 0, {
        resultId: 2,
        audioStartMs: 0,
        audioEndMs: 32,
        text: 'Settled original',
        isFinal: true,
        speechFinal: true,
      })
      await settle()

      expect(session.getSnapshot()).toMatchObject({ caption: 'Settled original', liveOriginal: '' })
      expect(overlayCalls.filter((call) => call.method === 'update')
        .some((call) => call.payload.subtitleText === 'Settled original'
          && call.payload.subtitleLiveText === 'Settled original')).toBe(false)
      expect(polishRequests()).toHaveLength(0)
    })
  })
})
