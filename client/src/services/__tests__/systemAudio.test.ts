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
import type { TranscriptionCallbacks, TranscriptionProvider } from '../transcription/types'
import type { SubtitleOverlayPayload } from '../recorder/types'
import { uint8ArrayToBase64 } from '@/lib/encoding'
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
  it('records timings and engine metadata for a translated subtitle run', async () => {
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
      llmText: 'Translated speech',
      asrMs: 12,
      llmMs: 34,
      durationSec: 0.64,
      asrEngine: 'test-engine',
      asrModel: 'test-model',
      aiStatus: 'applied',
      aiProvider: 'ollama',
      aiModel: 'translator',
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
    expect(request.text_context).toBeNull()
    expect(native.invoke.mock.calls.some(([name]) => ['paste_text', 'copy_text', 'mute_system_output', 'get_recording_context'].includes(name))).toBe(false)
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

  it('rejects AI fallback instead of displaying original ASR as a translation', async () => {
    const original = native.invoke.getMockImplementation()!
    native.invoke.mockImplementation((name, args) => name === 'cloud_polish' ? Promise.reject(new Error('AI unavailable')) : original(name, args))
    await session.start({ deviceId: '', targetLanguage: 'ru' })
    frames(20, 0.9)
    frames(15, 0)
    await settle()

    expect(session.getSnapshot().state).toBe('error')
    expect(session.getSnapshot().caption).toBe('')
    expect(session.getSnapshot().error).not.toBe('')
  })

  it('rejects an applied translation identical to the recognized speech instead of echoing the original', async () => {
    const original = native.invoke.getMockImplementation()!
    native.invoke.mockImplementation((name, args) => name === 'cloud_polish'
      ? Promise.resolve({ text: 'Original speech', elapsed_ms: 5 })
      : original(name, args))
    await session.start({ deviceId: '', targetLanguage: 'ru' })
    frames(20, 0.9)
    frames(15, 0)
    await settle()

    expect(session.getSnapshot().state).toBe('error')
    expect(session.getSnapshot().caption).toBe('')
    expect(session.getSnapshot().error).toContain('Translation failed')
  })

  it('keeps the interruption cause visible when native capture cleanup also fails', async () => {
    const original = native.invoke.getMockImplementation()!
    native.invoke.mockImplementation((name, args) => {
      if (name === 'cloud_polish') return Promise.reject(new Error('AI unavailable'))
      if (name === 'stop_system_audio_capture') return Promise.reject(new Error('Native cleanup unavailable'))
      return original(name, args)
    })
    await session.start({ deviceId: '', targetLanguage: 'ru' })
    frames(20, 0.9)
    frames(15, 0)
    await settle()

    expect(session.getSnapshot().state).toBe('error')
    expect(session.getSnapshot().error).toContain('Translation failed')
    expect(session.getSnapshot().error).toContain('Could not safely return to dictation')
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

  it('stops visibly when queued audio exceeds the budget rather than accumulating an unbounded backlog', async () => {
    const pending = deferred<{ text: string; elapsed_ms: number }>()
    const original = native.invoke.getMockImplementation()!
    native.invoke.mockImplementation((name, args) => name === 'local_transcribe' ? pending.promise : original(name, args))
    await session.start({ deviceId: '', targetLanguage: 'en' })
    frames(188, 0.9)
    await settle()
    frames(612, 0.9)
    await settle()

    expect(session.getSnapshot().state).toBe('error')
    expect(session.getSnapshot().error).toContain('keep up')
    expect(native.invoke.mock.calls.filter(([name]) => name === 'local_transcribe')).toHaveLength(1)
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
      llmText: 'Current subtitle',
      asrMs: 1,
      llmMs: 1,
      durationSec: 1,
      aiStatus: 'applied',
    })
    await settle()
    expect(overlayCalls.some((call) => call.method === 'update'
      && call.payload.subtitleText === 'Current subtitle')).toBe(true)
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
    { finalText: 'Server translation', expectedState: 'listening', expectedCaption: 'Server translation' },
    { finalText: 'Original speech', expectedState: 'error', expectedCaption: '' },
  ] as const)('uses server-managed translation with the caption prompt and rejects late messages from the closed socket: $finalText', async ({ finalText, expectedState, expectedCaption }) => {
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

    expect(session.getSnapshot().state).toBe(expectedState)
    expect(session.getSnapshot().caption).toBe(expectedCaption)
    if (expectedState === 'error') expect(session.getSnapshot().error).toContain('Translation failed')
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

  it('still fails visibly if a preserved translation job fails after a recoverable gap', async () => {
    const original = native.invoke.getMockImplementation()!
    native.invoke.mockImplementation((name, args) => name === 'cloud_polish' ? Promise.reject(new Error('AI unavailable')) : original(name, args))
    await session.start({ deviceId: 'headphones', targetLanguage: 'ru' })
    frames(20, 0.9)
    frames(15, 0, 0)
    frames(1, 0, 0, undefined, true)
    await settle()

    expect(session.getSnapshot().state).toBe('error')
    expect(session.getSnapshot().error).toContain('Translation failed')
    expect(session.getSnapshot().warning).toBe('')
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
})
