import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  invoke: vi.fn(),
  emit: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  addHistory: vi.fn(),
  saveRecordingAudio: vi.fn(),
  stopCapture: vi.fn(),
}))

vi.mock('@/services/store', () => ({
  addHistory: (...args: unknown[]) => harness.addHistory(...args),
  deleteHistory: vi.fn(async () => undefined),
  getActivePresetId: vi.fn(async () => 'intent'),
  getPromptPresets: vi.fn(async () => []),
  getSetting: vi.fn(async (key: string, fallback: unknown) => (
    harness.settings.has(key) ? harness.settings.get(key) : fallback
  )),
  recordStats: vi.fn(async () => undefined),
  setActivePresetId: vi.fn(async () => undefined),
  setSetting: vi.fn(async (key: string, value: unknown) => harness.settings.set(key, value)),
}))
vi.mock('@/services/audio', () => ({
  startCapture: vi.fn(),
  stopCapture: () => harness.stopCapture(),
}))
vi.mock('@/services/audioFileService', () => ({
  saveRecordingAudio: (...args: unknown[]) => harness.saveRecordingAudio(...args),
}))
vi.mock('@/services/personalization/store', () => ({
  getAppPromptRules: vi.fn(async () => []),
  getUserStats: vi.fn(async () => ({ totalWords: 0, totalSessions: 0, appStats: {} })),
  recordSessionStats: vi.fn(async () => ({ totalWords: 0, totalSessions: 0, appStats: {} })),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => harness.invoke(...args) }))
vi.mock('@tauri-apps/api/event', () => ({
  emit: (event: string, payload: unknown) => harness.emit(event, payload),
  listen: vi.fn(async (event: string, callback: (event: { payload: unknown }) => void) => {
    harness.listeners.set(event, callback)
    return () => harness.listeners.delete(event)
  }),
}))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn() }))
vi.mock('@/services/debugLog', () => ({ addRuntimeEvent: vi.fn() }))

import en from '@/i18n/locales/en.json'
import uk from '@/i18n/locales/uk.json'
import { setLocale } from '@/i18n'
import { describeProviderError } from '@/lib/errorMessages'
import { RecorderOrchestrator } from '../RecorderOrchestrator'
import { OverlayService } from '../OverlayService'
import { switchProvider, type TranscriptionCallbacks, type FinalResult } from '@/services/transcription'
import { dismissOverlayCard, onOverlayCardDismissed } from '@/services/bridge'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

async function flushMicrotasks() {
  for (let index = 0; index < 10; index++) await Promise.resolve()
}

function callbacksFor(recorder: RecorderOrchestrator): TranscriptionCallbacks {
  const createCallbacks = Reflect.get(RecorderOrchestrator.prototype, 'buildProviderCallbacks') as (
    this: RecorderOrchestrator,
  ) => TranscriptionCallbacks
  return createCallbacks.call(recorder)
}

function prepareRun(
  recorder: RecorderOrchestrator,
  runId: number,
  audioDurationSec = 1,
  state: 'recording' | 'processing' = 'processing',
) {
  Reflect.set(recorder, 'state', state)
  Reflect.set(recorder, 'activeRunId', runId)
  Reflect.set(recorder, 'audioSentSamples', Math.round(audioDurationSec * 16_000))
  Reflect.set(recorder, 'wallTimeAtStopSec', audioDurationSec)
  Reflect.set(recorder, 'recordedChunks', [new ArrayBuffer(Math.round(audioDurationSec * 32_000))])
}

function overlayPayloads(command: 'present_overlay' | 'update_overlay_state') {
  return harness.invoke.mock.calls
    .filter(([name]) => name === command)
    .map(([, args]) => (args as { data: Record<string, unknown> }).data)
}

function latestPayload(command: 'present_overlay' | 'update_overlay_state') {
  const payloads = overlayPayloads(command)
  return payloads[payloads.length - 1]
}

function makeFinal(overrides: Partial<FinalResult> = {}): FinalResult {
  return {
    asrText: 'recognized words',
    llmText: 'recognized words',
    asrMs: 12,
    llmMs: 0,
    durationSec: 1,
    ...overrides,
  }
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.stubGlobal('window', globalThis)
  harness.settings.clear()
  harness.settings.set('historyEnabled', true)
  harness.settings.set('audioRetentionEnabled', true)
  harness.listeners.clear()
  harness.emit.mockReset().mockImplementation(async (event: string, payload: unknown) => {
    harness.listeners.get(event)?.({ payload })
  })
  harness.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === 'paste_text') return { ok: true, strategy: 'sendinput' }
    if (command === 'get_probe_result') {
      return { editable: true, hwnd: '0x1', process: 'Editor', detail: 'editable' }
    }
    return 1
  })
  harness.addHistory.mockReset().mockResolvedValue(undefined)
  harness.saveRecordingAudio.mockReset().mockResolvedValue('history/recording.wav')
  harness.stopCapture.mockReset().mockResolvedValue(undefined)
  await switchProvider('cloud_api')
  setLocale('en')
})

afterEach(() => {
  setLocale('en')
  vi.clearAllTimers()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('recorder failure cards', () => {
  it('presents a localized provider failure before archival finishes and uses only the canonical safe cause', async () => {
    setLocale('uk')
    const archive = deferred<void>()
    const historyStarted = deferred<Record<string, unknown>>()
    harness.addHistory.mockImplementation((record: Record<string, unknown>) => {
      historyStarted.resolve(record)
      return archive.promise
    })

    const recorder = new RecorderOrchestrator()
    prepareRun(recorder, 41)
    const message = 'sayit_error:provider_insufficient_balance:HTTP 402 {"message":"private vendor response"}'
    callbacksFor(recorder).onError?.(message)

    const card = latestPayload('present_overlay')
    expect(card).toMatchObject({
      state: 'failure',
      failureTitle: uk['recorder.recognitionFailedTitle'],
      failureDetail: describeProviderError(message).message,
      failureRecovery: 'unknown',
      cardToken: 41,
    })
    expect(card?.failureDetail).not.toContain('private vendor response')
    expect(recorder.getState()).toBe('idle')

    const archived = await historyStarted.promise
    expect(archived).toMatchObject({
      audioFilePath: 'history/recording.wav',
      failReasonCode: 'provider_insufficient_balance',
    })
    expect(overlayPayloads('update_overlay_state')).toEqual([])

    archive.resolve()
    await flushMicrotasks()
  })

  it('adds the History retry hint only after persistence succeeds with a saved audio path', async () => {
    const archive = deferred<void>()
    const historyStarted = deferred<Record<string, unknown>>()
    harness.addHistory.mockImplementation((record: Record<string, unknown>) => {
      historyStarted.resolve(record)
      return archive.promise
    })

    const recorder = new RecorderOrchestrator()
    prepareRun(recorder, 42)
    callbacksFor(recorder).onError?.('HTTP 429 rate limit')

    expect(latestPayload('present_overlay')).toMatchObject({ failureRecovery: 'unknown' })
    const record = await historyStarted.promise
    expect(record.audioFilePath).toBe('history/recording.wav')
    expect(overlayPayloads('update_overlay_state')).toEqual([])

    archive.resolve()
    await flushMicrotasks()
    expect(latestPayload('update_overlay_state')).toMatchObject({
      state: 'failure',
      failureTitle: en['recorder.recognitionFailedTitle'],
      failureDetail: describeProviderError('HTTP 429 rate limit').message,
      failureRecovery: 'history',
      cardToken: 42,
    })
  })

  it.each([
    { name: 'history disabled', historyEnabled: false, retentionEnabled: true, savePath: 'history/file.wav', historyFails: false },
    { name: 'audio retention disabled', historyEnabled: true, retentionEnabled: false, savePath: 'history/file.wav', historyFails: false },
    { name: 'audio save returns no path', historyEnabled: true, retentionEnabled: true, savePath: null, historyFails: false },
    { name: 'audio save fails', historyEnabled: true, retentionEnabled: true, savePath: 'reject', historyFails: false },
    { name: 'history persistence fails', historyEnabled: true, retentionEnabled: true, savePath: 'history/file.wav', historyFails: true },
  ])('does not promise History retry when $name', async ({ historyEnabled, retentionEnabled, savePath, historyFails }) => {
    harness.settings.set('historyEnabled', historyEnabled)
    harness.settings.set('audioRetentionEnabled', retentionEnabled)
    if (savePath === 'reject') {
      harness.saveRecordingAudio.mockRejectedValue(new Error('disk unavailable'))
    } else {
      harness.saveRecordingAudio.mockResolvedValue(savePath)
    }
    if (historyFails) harness.addHistory.mockRejectedValue(new Error('history unavailable'))

    const recorder = new RecorderOrchestrator()
    prepareRun(recorder, 50)
    callbacksFor(recorder).onError?.('HTTP 500 provider failure')
    await flushMicrotasks()

    expect(latestPayload('update_overlay_state')?.failureRecovery).toBe('none')
    expect(overlayPayloads('update_overlay_state').every((payload) => payload.state === 'failure')).toBe(true)
    if (!historyEnabled) {
      expect(harness.addHistory).not.toHaveBeenCalled()
      expect(harness.saveRecordingAudio).not.toHaveBeenCalled()
    } else if (!retentionEnabled) {
      expect(harness.addHistory).toHaveBeenCalledTimes(1)
      expect(harness.saveRecordingAudio).not.toHaveBeenCalled()
    } else {
      expect(harness.saveRecordingAudio).toHaveBeenCalledTimes(1)
    }
  })

  it('expires five seconds after presentation even when recovery arrives late', async () => {
    const archive = deferred<void>()
    const historyStarted = deferred<Record<string, unknown>>()
    harness.addHistory.mockImplementation((record: Record<string, unknown>) => {
      historyStarted.resolve(record)
      return archive.promise
    })

    const recorder = new RecorderOrchestrator()
    prepareRun(recorder, 60)
    callbacksFor(recorder).onError?.('HTTP 500 provider failure')
    await historyStarted.promise

    await vi.advanceTimersByTimeAsync(4_900)
    expect(harness.invoke.mock.calls.filter(([command]) => command === 'hide_overlay')).toHaveLength(0)
    archive.resolve()
    await flushMicrotasks()
    expect(latestPayload('update_overlay_state')?.failureRecovery).toBe('history')

    await vi.advanceTimersByTimeAsync(99)
    expect(harness.invoke.mock.calls.filter(([command]) => command === 'hide_overlay')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(harness.invoke.mock.calls.filter(([command]) => command === 'hide_overlay')).toHaveLength(1)
  })

  it('dismisses only the owned failure card and rejects its stale recovery update', () => {
    const overlay = new OverlayService(() => 0)
    overlay.showFailure({
      failureTitle: 'Recognition failed',
      failureDetail: 'Try again.',
      failureRecovery: 'unknown',
      cardToken: 65,
    })
    overlay.dismissCard(65)
    expect(harness.invoke.mock.calls.filter(([command]) => command === 'hide_overlay')).toHaveLength(1)
    overlay.updateFailureRecovery('history', 65)
    expect(overlayPayloads('update_overlay_state')).toEqual([])

    overlay.showFallback('replacement text', 'not_editable', 66)
    overlay.dismissCard(65)
    expect(harness.invoke.mock.calls.filter(([command]) => command === 'hide_overlay')).toHaveLength(1)
    vi.advanceTimersByTime(9_999)
    expect(harness.invoke.mock.calls.filter(([command]) => command === 'hide_overlay')).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(harness.invoke.mock.calls.filter(([command]) => command === 'hide_overlay')).toHaveLength(2)
  })

  it('notifies the controller with the exact card token when the failure close button is used', async () => {
    const dismissedTokens: number[] = []
    const unlisten = onOverlayCardDismissed(({ token }) => dismissedTokens.push(token))

    await dismissOverlayCard(67)

    expect(dismissedTokens).toEqual([67])
    unlisten()
  })

  it('keeps a newer fallback card and its ten-second lifetime when an older failure archive completes', async () => {
    const archive = deferred<void>()
    const historyStarted = deferred<Record<string, unknown>>()
    harness.addHistory.mockImplementation((record: Record<string, unknown>) => {
      historyStarted.resolve(record)
      return archive.promise
    })

    const recorder = new RecorderOrchestrator()
    prepareRun(recorder, 70)
    callbacksFor(recorder).onError?.('HTTP 500 provider failure')
    await historyStarted.promise

    const overlay = Reflect.get(recorder, 'overlayService') as OverlayService
    overlay.showFallback('new run transcript', 'not_editable', 71)
    await vi.advanceTimersByTimeAsync(5_000)
    archive.resolve()
    await flushMicrotasks()

    expect(latestPayload('present_overlay')).toMatchObject({
      state: 'fallback',
      fallbackText: 'new run transcript',
      fallbackReason: 'not_editable',
    })
    expect(overlayPayloads('update_overlay_state').some((payload) => payload.state === 'failure')).toBe(false)
    expect(harness.invoke.mock.calls.filter(([command]) => command === 'hide_overlay')).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(4_999)
    expect(harness.invoke.mock.calls.filter(([command]) => command === 'hide_overlay')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(harness.invoke.mock.calls.filter(([command]) => command === 'hide_overlay')).toHaveLength(1)
  })

  it('shows an incomplete-protocol card only when onDone has no ASR or final result', async () => {
    const recorder = new RecorderOrchestrator()
    prepareRun(recorder, 80)
    callbacksFor(recorder).onDone?.()

    expect(latestPayload('present_overlay')).toMatchObject({
      state: 'failure',
      failureTitle: en['recorder.protocolIncompleteTitle'],
      failureDetail: en['recorder.protocolIncompleteDetail'],
      cardToken: 80,
    })

    harness.invoke.mockClear()
    const partialRecorder = new RecorderOrchestrator()
    prepareRun(partialRecorder, 81)
    const callbacks = callbacksFor(partialRecorder)
    callbacks.onASR?.({ text: 'partial transcript', asrMs: 8, durationSec: 1 })
    callbacks.onDone?.()
    expect(overlayPayloads('present_overlay').some((payload) => payload.state === 'failure')).toBe(false)
    expect(partialRecorder.getState()).toBe('idle')
  })

  it('keeps successful empty ASR and final results on the no-speech toast path', async () => {
    const asrRecorder = new RecorderOrchestrator()
    prepareRun(asrRecorder, 90)
    callbacksFor(asrRecorder).onASR?.({ text: '', asrMs: 10, durationSec: 1 })
    await flushMicrotasks()
    expect(overlayPayloads('present_overlay').map((payload) => payload.state)).toContain('toast')
    expect(overlayPayloads('present_overlay').some((payload) => payload.state === 'failure')).toBe(false)

    harness.invoke.mockClear()
    const finalRecorder = new RecorderOrchestrator()
    prepareRun(finalRecorder, 91)
    callbacksFor(finalRecorder).onFinal?.(makeFinal({ asrText: '', llmText: '' }))
    await flushMicrotasks()
    expect(overlayPayloads('present_overlay').map((payload) => payload.state)).toContain('toast')
    expect(overlayPayloads('present_overlay').some((payload) => payload.state === 'failure')).toBe(false)
  })

  it('shows a failure card when nonempty ASR text is removed by post-processing', async () => {
    harness.settings.set('textReplacements', [
      { id: 'remove-recognized-text', from: 'recognized words', to: '', enabled: true },
    ])
    const historyStarted = deferred<Record<string, unknown>>()
    harness.addHistory.mockImplementation((record: Record<string, unknown>) => {
      historyStarted.resolve(record)
      return Promise.resolve()
    })
    const recorder = new RecorderOrchestrator()
    prepareRun(recorder, 100)
    callbacksFor(recorder).onFinal?.(makeFinal())
    await historyStarted.promise
    await flushMicrotasks()

    expect(latestPayload('present_overlay')).toMatchObject({
      state: 'failure',
      failureTitle: en['recorder.emptyAfterProcessingTitle'],
      failureDetail: en['recorder.emptyAfterProcessingDetail'],
      failureRecovery: 'unknown',
      cardToken: 100,
    })
    expect(latestPayload('update_overlay_state')).toMatchObject({
      state: 'failure',
      failureTitle: en['recorder.emptyAfterProcessingTitle'],
      failureDetail: en['recorder.emptyAfterProcessingDetail'],
      failureRecovery: 'history',
      cardToken: 100,
    })
    expect(harness.addHistory).toHaveBeenCalledWith(expect.objectContaining({
      failReasonCode: 'empty_after_processing',
      audioFilePath: 'history/recording.wav',
    }))
  })

  it('keeps short provider errors transient and user cancellation non-card', async () => {
    const shortErrorRecorder = new RecorderOrchestrator()
    prepareRun(shortErrorRecorder, 110, 0.4)
    callbacksFor(shortErrorRecorder).onError?.('HTTP 500 provider failure')
    expect(overlayPayloads('present_overlay').some((payload) => payload.state === 'failure')).toBe(false)
    await flushMicrotasks()
    expect(harness.addHistory).not.toHaveBeenCalled()

    harness.invoke.mockClear()
    const canceledRecorder = new RecorderOrchestrator()
    prepareRun(canceledRecorder, 111, 1, 'recording')
    const cancelRecording = Reflect.get(RecorderOrchestrator.prototype, 'cancelRecording') as (
      this: RecorderOrchestrator,
      token: number,
    ) => Promise<void>
    await cancelRecording.call(canceledRecorder, 111)
    expect(overlayPayloads('present_overlay').map((payload) => payload.state)).toContain('toast')
    expect(overlayPayloads('present_overlay').some((payload) => payload.state === 'failure')).toBe(false)
  })

  it('keeps short recordings and mic-muted auto-cancel out of the failure-card path', async () => {
    const shortRecorder = new RecorderOrchestrator()
    prepareRun(shortRecorder, 120, 0.4, 'recording')
    const stopRecording = Reflect.get(RecorderOrchestrator.prototype, 'stopRecording') as (
      this: RecorderOrchestrator,
    ) => Promise<void>
    await stopRecording.call(shortRecorder)
    expect(overlayPayloads('present_overlay').some((payload) => payload.state === 'failure')).toBe(false)

    const mutedRecorder = new RecorderOrchestrator()
    prepareRun(mutedRecorder, 121, 1, 'recording')
    Reflect.set(mutedRecorder, 'osMicMuted', true)
    const scheduleAutoCancel = Reflect.get(RecorderOrchestrator.prototype, 'scheduleMicMutedAutoCancel') as (
      this: RecorderOrchestrator,
      runId: number,
    ) => void
    scheduleAutoCancel.call(mutedRecorder, 121)
    await vi.advanceTimersByTimeAsync(3_000)
    await flushMicrotasks()
    expect(overlayPayloads('present_overlay').some((payload) => payload.state === 'failure')).toBe(false)
  })

  it('accepts an eligible late final during the existing fifteen-second grace period', async () => {
    const provider = await switchProvider('cloud_api')
    vi.spyOn(provider, 'stop').mockReturnValue(true)
    const recorder = new RecorderOrchestrator()
    prepareRun(recorder, 130, 1, 'recording')
    Reflect.set(recorder, 'recordStartPerf', performance.now() - 1_000)
    Reflect.set(recorder, 'cachedProbeResult', {
      editable: true,
      hwnd: '0x1',
      process: 'Editor',
      detail: 'editable',
    })
    const callbacks = callbacksFor(recorder)
    const stopRecording = Reflect.get(RecorderOrchestrator.prototype, 'stopRecording') as (
      this: RecorderOrchestrator,
    ) => Promise<void>
    await stopRecording.call(recorder)

    await vi.advanceTimersByTimeAsync(30_500)
    expect(overlayPayloads('present_overlay').some((payload) => payload.state === 'failure')).toBe(false)
    await vi.advanceTimersByTimeAsync(14_999)
    expect(overlayPayloads('present_overlay').some((payload) => payload.state === 'failure')).toBe(false)

    const historyWritten = deferred<Record<string, unknown>>()
    harness.addHistory.mockImplementation((record: Record<string, unknown>) => {
      historyWritten.resolve(record)
      return Promise.resolve()
    })
    callbacks.onFinal?.(makeFinal())
    await historyWritten.promise
    await flushMicrotasks()
    expect(harness.invoke).toHaveBeenCalledWith('paste_text', expect.objectContaining({ text: 'recognized words' }))
    expect(overlayPayloads('present_overlay').some((payload) => payload.state === 'failure')).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(overlayPayloads('present_overlay').some((payload) => payload.state === 'failure')).toBe(false)
  })

  it('shows timeout failure only after the existing fifteen-second grace expires', async () => {
    const provider = await switchProvider('cloud_api')
    vi.spyOn(provider, 'stop').mockReturnValue(true)
    const historyStarted = deferred<Record<string, unknown>>()
    harness.addHistory.mockImplementation((record: Record<string, unknown>) => {
      historyStarted.resolve(record)
      return Promise.resolve()
    })
    const recorder = new RecorderOrchestrator()
    prepareRun(recorder, 140, 1, 'recording')
    Reflect.set(recorder, 'recordStartPerf', performance.now() - 1_000)
    const stopRecording = Reflect.get(RecorderOrchestrator.prototype, 'stopRecording') as (
      this: RecorderOrchestrator,
    ) => Promise<void>
    await stopRecording.call(recorder)

    await vi.advanceTimersByTimeAsync(30_500)
    expect(overlayPayloads('present_overlay').some((payload) => payload.state === 'failure')).toBe(false)
    await vi.advanceTimersByTimeAsync(14_999)
    expect(overlayPayloads('present_overlay').some((payload) => payload.state === 'failure')).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    expect(latestPayload('present_overlay')).toMatchObject({
      state: 'failure',
      failureTitle: en['recorder.processingTimeoutTitle'],
      failureDetail: en['recorder.processingTimeoutDetail'],
      cardToken: 140,
    })
    await expect(historyStarted.promise).resolves.toMatchObject({
      audioFilePath: 'history/recording.wav',
      isEmpty: true,
    })
  })
})
