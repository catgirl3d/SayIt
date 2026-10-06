import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  historyReadError: false,
  suppressLateSettingReadError: false,
  suppressLateSettingReadCount: 0,
  unrelatedSettingsReadError: false,
  invoke: vi.fn(),
  emit: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  runtimeEvents: vi.fn(),
  addHistory: vi.fn(),
  recordStats: vi.fn(),
  recordSessionStats: vi.fn(),
  startCapture: vi.fn(),
  saveRecordingAudio: vi.fn(),
  stopCapture: vi.fn(),
}))

vi.mock('@/services/store', () => ({
  addHistory: (...args: unknown[]) => harness.addHistory(...args),
  deleteHistory: vi.fn(async () => undefined),
  getActivePresetId: vi.fn(async () => 'intent'),
  getPromptPresets: vi.fn(async () => []),
  getSetting: vi.fn(async (key: string, fallback: unknown) => {
    if (key === 'historyEnabled' && harness.historyReadError) throw new Error('history setting unavailable')
    if (key === 'suppressLateFinalInsertion') {
      harness.suppressLateSettingReadCount++
      if (harness.suppressLateSettingReadError) throw new Error('private late-insertion setting detail')
    }
    if (key === 'selectedMic' && harness.unrelatedSettingsReadError) throw new Error('microphone setting unavailable')
    return harness.settings.has(key) ? harness.settings.get(key) : fallback
  }),
  recordStats: (...args: unknown[]) => harness.recordStats(...args),
  setActivePresetId: vi.fn(async () => undefined),
  setSetting: vi.fn(async (key: string, value: unknown) => harness.settings.set(key, value)),
}))
vi.mock('@/services/audio', () => ({
  startCapture: (...args: unknown[]) => harness.startCapture(...args),
  stopCapture: () => harness.stopCapture(),
}))
vi.mock('@/services/audioFileService', () => ({
  saveRecordingAudio: (...args: unknown[]) => harness.saveRecordingAudio(...args),
}))
vi.mock('@/services/personalization/store', () => ({
  getAppPromptRules: vi.fn(async () => []),
  getUserStats: vi.fn(async () => ({ totalWords: 0, totalSessions: 0, domainWords: {}, appUsageCount: {} })),
  recordSessionStats: (...args: unknown[]) => harness.recordSessionStats(...args),
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
vi.mock('@/services/debugLog', () => ({ addRuntimeEvent: (...args: unknown[]) => harness.runtimeEvents(...args) }))

import en from '@/i18n/locales/en.json'
import uk from '@/i18n/locales/uk.json'
import { DEFAULTS } from '@/services/defaults'
import { setLocale } from '@/i18n'
import { describeProviderError } from '@/lib/errorMessages'
import * as textPostProcess from '@/services/textPostProcess'
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

async function acquireSubtitles(recorder: RecorderOrchestrator) {
  const acquire = Reflect.get(recorder, 'acquireSystemAudio') as (() => Promise<void>) | undefined
  if (acquire) await acquire.call(recorder)
}

async function enterTimeoutGrace(recorder: RecorderOrchestrator, runId: number, refreshSettings = true) {
  const provider = await switchProvider('cloud_api')
  vi.spyOn(provider, 'stop').mockReturnValue(true)
  if (refreshSettings) await recorder.refreshRuntimeSettings()
  prepareRun(recorder, runId, 1, 'recording')
  Reflect.set(recorder, 'recordStartPerf', performance.now() - 1_000)
  Reflect.set(recorder, 'cachedProbeResult', {
    editable: true,
    hwnd: '0x1',
    process: 'Editor',
    detail: 'editable',
  })
  const stopRecording = Reflect.get(RecorderOrchestrator.prototype, 'stopRecording') as (
    this: RecorderOrchestrator,
  ) => Promise<void>
  await stopRecording.call(recorder)
  await vi.advanceTimersByTimeAsync(30_500)
  return callbacksFor(recorder)
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.stubGlobal('window', globalThis)
  harness.settings.clear()
  harness.historyReadError = false
  harness.suppressLateSettingReadError = false
  harness.suppressLateSettingReadCount = 0
  harness.unrelatedSettingsReadError = false
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
  harness.runtimeEvents.mockReset()
  harness.recordStats.mockReset().mockResolvedValue(undefined)
  harness.recordSessionStats.mockReset().mockResolvedValue({ totalWords: 0, totalSessions: 0, domainWords: {}, appUsageCount: {} })
  harness.startCapture.mockReset().mockResolvedValue({ label: 'Microphone', deviceId: 'device-1', groupId: 'group-1' })
  harness.saveRecordingAudio.mockReset().mockResolvedValue('history/recording.wav')
  harness.stopCapture.mockReset().mockResolvedValue(undefined)
  await switchProvider('cloud_api')
  setLocale('en')
})

afterEach(() => {
  setLocale('en')
  vi.restoreAllMocks()
  vi.clearAllTimers()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('recorder failure cards', () => {
  it('defaults late-result insertion suppression to off', () => {
    expect(DEFAULTS.suppressLateFinalInsertion).toBe(false)
  })

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
    const recorder = new RecorderOrchestrator()
    const callbacks = await enterTimeoutGrace(recorder, 130)
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

  it('saves an opted-in late final once without inserting it', async () => {
    harness.settings.set('suppressLateFinalInsertion', true)
    const recorder = new RecorderOrchestrator()
    const callbacks = await enterTimeoutGrace(recorder, 131)
    const historyWritten = deferred<Record<string, unknown>>()
    harness.addHistory.mockImplementation((record: Record<string, unknown>) => {
      historyWritten.resolve(record)
      return Promise.resolve()
    })

    callbacks.onFinal?.(makeFinal())
    const savedHistory = await historyWritten.promise
    expect(savedHistory).toMatchObject({
      asrText: 'recognized words',
      llmText: 'recognized words',
      isEmpty: false,
    })
    expect(savedHistory.charCount).toBe('recognized words'.length)
    expect(savedHistory.durationSec).toBeGreaterThan(0)
    await flushMicrotasks()

    expect(harness.addHistory).toHaveBeenCalledTimes(1)
    expect(harness.recordSessionStats).not.toHaveBeenCalled()
    expect(harness.recordStats).not.toHaveBeenCalled()
    expect(harness.invoke.mock.calls.filter(([command]) => command === 'paste_text')).toHaveLength(0)
    expect(overlayPayloads('present_overlay').some((payload) => payload.state === 'fallback')).toBe(false)
    expect(Reflect.get(recorder, 'activeRunId')).toBe(0)
    expect(Reflect.get(recorder, 'finalizingLateRunId')).toBe(0)
  })

  it('continues initialization and fails closed only for late insertion when its setting read fails', async () => {
    harness.suppressLateSettingReadError = true
    harness.settings.set('selectedMic', 'saved-mic')
    const recorder = new RecorderOrchestrator()
    const provider = await switchProvider('cloud_api')
    provider.disconnect()
    const connect = vi.spyOn(provider, 'connect').mockResolvedValue(undefined)
    vi.spyOn(provider, 'isReady').mockReturnValue(false)
    vi.spyOn(provider, 'stop').mockReturnValue(true)

    await expect(recorder.init()).resolves.toBeUndefined()

    expect(Reflect.get(recorder, 'cachedMicId')).toBe('saved-mic')
    expect(connect).toHaveBeenCalledTimes(1)
    const callbacks = connect.mock.calls[0]?.[0]
    expect(callbacks?.onFinal).toBeTypeOf('function')
    expect(harness.runtimeEvents).toHaveBeenCalledWith(
      'warn',
      'recorder',
      'Late-insertion setting unavailable; suppressing late result insertion',
    )
    expect(JSON.stringify(harness.runtimeEvents.mock.calls)).not.toContain('private late-insertion setting detail')

    prepareRun(recorder, 190, 1, 'recording')
    Reflect.set(recorder, 'recordStartPerf', performance.now() - 1_000)
    Reflect.set(recorder, 'cachedProbeResult', { editable: true, hwnd: '0x1', process: 'Editor', detail: 'editable' })
    const stopRecording = Reflect.get(RecorderOrchestrator.prototype, 'stopRecording') as (
      this: RecorderOrchestrator,
    ) => Promise<void>
    await stopRecording.call(recorder)
    await vi.advanceTimersByTimeAsync(30_500)
    expect(Reflect.get(recorder, 'timedOutProcessingContext')).toMatchObject({
      runId: 190,
      suppressLateFinalInsertion: true,
    })
    await vi.advanceTimersByTimeAsync(14_999)

    harness.addHistory.mockClear()
    harness.invoke.mockClear()
    const lateHistory = deferred<Record<string, unknown>>()
    harness.addHistory.mockImplementation((record: Record<string, unknown>) => {
      lateHistory.resolve(record)
      return Promise.resolve()
    })
    callbacks?.onFinal?.(makeFinal())
    await flushMicrotasks()
    expect(harness.runtimeEvents.mock.calls.some(([, , message]) => message === 'Final result received')).toBe(true)
    await expect(lateHistory.promise).resolves.toMatchObject({
      asrText: 'recognized words',
      llmText: 'recognized words',
      isEmpty: false,
    })
    expect(harness.invoke.mock.calls.filter(([command]) => command === 'paste_text')).toHaveLength(0)

    harness.invoke.mockClear()
    prepareRun(recorder, 191, 1, 'processing')
    Reflect.set(recorder, 'cachedProbeResult', { editable: true, hwnd: '0x1', process: 'Editor', detail: 'editable' })
    const onTimeHistory = deferred<Record<string, unknown>>()
    harness.addHistory.mockClear()
    harness.addHistory.mockImplementation((record: Record<string, unknown>) => {
      onTimeHistory.resolve(record)
      return Promise.resolve()
    })
    callbacks?.onFinal?.(makeFinal({ asrText: 'on-time words', llmText: 'on-time words' }))
    await expect(onTimeHistory.promise).resolves.toMatchObject({ llmText: 'on-time words' })
    await flushMicrotasks()
    expect(harness.invoke).toHaveBeenCalledWith('paste_text', expect.objectContaining({ text: 'on-time words' }))
  })

  it('applies explicit late-insertion cache changes in both directions without rereading the setting', async () => {
    const recorder = new RecorderOrchestrator()

    recorder.setSuppressLateFinalInsertionCache(true)
    const suppressedCallbacks = await enterTimeoutGrace(recorder, 192, false)
    expect(Reflect.get(recorder, 'timedOutProcessingContext')).toMatchObject({
      runId: 192,
      suppressLateFinalInsertion: true,
    })
    await vi.advanceTimersByTimeAsync(14_999)
    harness.addHistory.mockClear()
    const suppressedHistory = deferred<Record<string, unknown>>()
    harness.addHistory.mockImplementation((record: Record<string, unknown>) => {
      suppressedHistory.resolve(record)
      return Promise.resolve()
    })
    harness.invoke.mockClear()
    suppressedCallbacks.onFinal?.(makeFinal())
    await expect(suppressedHistory.promise).resolves.toMatchObject({ llmText: 'recognized words' })
    await flushMicrotasks()
    expect(harness.runtimeEvents.mock.calls.some(([, , message]) => message === 'Final result received')).toBe(true)
    expect(harness.invoke.mock.calls.filter(([command]) => command === 'paste_text')).toHaveLength(0)
    expect(harness.addHistory).toHaveBeenCalledTimes(1)

    recorder.setSuppressLateFinalInsertionCache(false)
    const insertionCallbacks = await enterTimeoutGrace(recorder, 193, false)
    harness.addHistory.mockClear()
    const insertionHistory = deferred<Record<string, unknown>>()
    harness.addHistory.mockImplementation((record: Record<string, unknown>) => {
      insertionHistory.resolve(record)
      return Promise.resolve()
    })
    harness.invoke.mockClear()
    insertionCallbacks.onFinal?.(makeFinal())
    await expect(insertionHistory.promise).resolves.toMatchObject({ llmText: 'recognized words' })
    await flushMicrotasks()
    expect(harness.invoke).toHaveBeenCalledWith('paste_text', expect.objectContaining({ text: 'recognized words' }))
    expect(harness.suppressLateSettingReadCount).toBe(0)
  })

  it('does not count a History-only late result and permits the next recording', async () => {
    harness.settings.set('suppressLateFinalInsertion', true)
    const historyWritten = deferred<Record<string, unknown>>()
    harness.addHistory.mockImplementation((record: Record<string, unknown>) => {
      historyWritten.resolve(record)
      return Promise.resolve()
    })
    const recorder = new RecorderOrchestrator()
    const callbacks = await enterTimeoutGrace(recorder, 141)

    callbacks.onFinal?.(makeFinal())
    await expect(historyWritten.promise).resolves.toMatchObject({ llmText: 'recognized words' })
    await flushMicrotasks()

    expect(harness.addHistory).toHaveBeenCalledTimes(1)
    expect(harness.recordSessionStats).not.toHaveBeenCalled()
    expect(harness.recordStats).not.toHaveBeenCalled()
    expect(Reflect.get(recorder, 'finalizingLateRunId')).toBe(0)
    expect(harness.invoke.mock.calls.filter(([command]) => command === 'paste_text')).toHaveLength(0)

    Reflect.set(recorder, 'cachedPresets', [{ id: 'intent', name: 'Intent', systemPrompt: '', builtin: true }])
    vi.stubGlobal('document', { activeElement: null, documentElement: { lang: '' } })
    vi.stubGlobal('HTMLElement', class { })
    const provider = await switchProvider('cloud_api')
    vi.spyOn(provider, 'isReady').mockReturnValue(true)
    vi.spyOn(provider, 'connect').mockResolvedValue(undefined)
    vi.spyOn(provider, 'start').mockReturnValue(true)
    const startRecording = Reflect.get(RecorderOrchestrator.prototype, 'startRecording') as (
      this: RecorderOrchestrator,
    ) => Promise<void>

    await startRecording.call(recorder)
    const newRunId = Reflect.get(recorder, 'activeRunId')
    expect(recorder.getState()).toBe('recording')
    expect(newRunId).not.toBe(141)
    expect(Reflect.get(recorder, 'activeRunId')).toBe(newRunId)
    expect(harness.recordSessionStats).not.toHaveBeenCalled()
    expect(harness.invoke.mock.calls.filter(([command]) => command === 'paste_text')).toHaveLength(0)
  })

  it('keeps the empty-after-processing History failure path for an opted-in late final', async () => {
    harness.settings.set('suppressLateFinalInsertion', true)
    harness.settings.set('textReplacements', [
      { id: 'remove-recognized-text', from: 'recognized words', to: '', enabled: true },
    ])
    const historyWritten = deferred<Record<string, unknown>>()
    harness.addHistory.mockImplementation((record: Record<string, unknown>) => {
      historyWritten.resolve(record)
      return Promise.resolve()
    })
    const recorder = new RecorderOrchestrator()
    const callbacks = await enterTimeoutGrace(recorder, 138)

    callbacks.onFinal?.(makeFinal())
    await expect(historyWritten.promise).resolves.toMatchObject({
      isEmpty: true,
      failReasonCode: 'empty_after_processing',
    })
    await flushMicrotasks()

    expect(latestPayload('present_overlay')).toMatchObject({
      state: 'failure',
      failureTitle: en['recorder.emptyAfterProcessingTitle'],
      failureDetail: en['recorder.emptyAfterProcessingDetail'],
      cardToken: 138,
    })
    expect(harness.invoke.mock.calls.filter(([command]) => command === 'paste_text')).toHaveLength(0)
  })

  it.each([
    { name: 'History is disabled', historyEnabled: false, historyReadError: false },
    { name: 'the History setting cannot be read', historyEnabled: true, historyReadError: true },
  ])('drops an opted-in late final when $name', async ({ historyEnabled, historyReadError }) => {
    harness.settings.set('suppressLateFinalInsertion', true)
    harness.settings.set('historyEnabled', historyEnabled)
    const transformSpy = vi.spyOn(textPostProcess, 'applyTextTransforms')
    const recorder = new RecorderOrchestrator()
    const callbacks = await enterTimeoutGrace(recorder, historyReadError ? 133 : 132)
    harness.historyReadError = historyReadError

    callbacks.onFinal?.(makeFinal())
    await flushMicrotasks()

    expect(transformSpy).not.toHaveBeenCalled()
    expect(harness.addHistory).not.toHaveBeenCalled()
    expect(harness.recordStats).not.toHaveBeenCalled()
    expect(harness.recordSessionStats).not.toHaveBeenCalled()
    expect(harness.invoke.mock.calls.filter(([command]) => command === 'paste_text')).toHaveLength(0)
    expect(overlayPayloads('present_overlay').some((payload) => payload.state === 'fallback')).toBe(false)
    expect(overlayPayloads('present_overlay').some((payload) => payload.state === 'failure')).toBe(false)
    expect(Reflect.get(recorder, 'activeRunId')).toBe(0)
    expect(Reflect.get(recorder, 'finalizingLateRunId')).toBe(0)
  })

  it('does not insert or retain stats when saving an opted-in late final to History fails', async () => {
    harness.settings.set('suppressLateFinalInsertion', true)
    const recorder = new RecorderOrchestrator()
    const callbacks = await enterTimeoutGrace(recorder, 134)
    const historyAttempted = deferred<Record<string, unknown>>()
    harness.addHistory.mockImplementation((record: Record<string, unknown>) => {
      historyAttempted.resolve(record)
      return Promise.reject(new Error('history unavailable'))
    })

    callbacks.onFinal?.(makeFinal())
    await expect(historyAttempted.promise).resolves.toMatchObject({ llmText: 'recognized words' })
    await flushMicrotasks()

    expect(harness.addHistory).toHaveBeenCalledTimes(1)
    expect(harness.recordStats).not.toHaveBeenCalled()
    expect(harness.recordSessionStats).not.toHaveBeenCalled()
    expect(harness.invoke.mock.calls.filter(([command]) => command === 'paste_text')).toHaveLength(0)
    expect(overlayPayloads('present_overlay').some((payload) => payload.state === 'fallback')).toBe(false)
    expect(overlayPayloads('present_overlay').some((payload) => payload.state === 'failure')).toBe(false)
    expect(Reflect.get(recorder, 'activeRunId')).toBe(0)
    expect(Reflect.get(recorder, 'finalizingLateRunId')).toBe(0)
  })

  it('does not show a fallback or insert when transforming an opted-in late final fails', async () => {
    harness.settings.set('suppressLateFinalInsertion', true)
    const transformSpy = vi.spyOn(textPostProcess, 'applyTextTransforms').mockRejectedValue(new Error('transform failed'))
    const recorder = new RecorderOrchestrator()
    const callbacks = await enterTimeoutGrace(recorder, 135)

    callbacks.onFinal?.(makeFinal())
    await flushMicrotasks()

    expect(transformSpy).toHaveBeenCalledTimes(1)
    expect(harness.addHistory).not.toHaveBeenCalled()
    expect(harness.invoke.mock.calls.filter(([command]) => command === 'paste_text')).toHaveLength(0)
    expect(overlayPayloads('present_overlay').some((payload) => payload.state === 'fallback')).toBe(false)
    expect(overlayPayloads('present_overlay').some((payload) => payload.state === 'failure')).toBe(false)
    expect(Reflect.get(recorder, 'activeRunId')).toBe(0)
    expect(Reflect.get(recorder, 'finalizingLateRunId')).toBe(0)
  })

  it.each([
    { name: 'enabled at timeout', timeoutSetting: true, graceSetting: false, expectedPasteCount: 0 },
    { name: 'disabled at timeout', timeoutSetting: false, graceSetting: true, expectedPasteCount: 1 },
  ])('freezes insertion suppression when it was $name', async ({ timeoutSetting, graceSetting, expectedPasteCount }) => {
    harness.settings.set('suppressLateFinalInsertion', timeoutSetting)
    const recorder = new RecorderOrchestrator()
    const callbacks = await enterTimeoutGrace(recorder, 136)
    harness.settings.set('suppressLateFinalInsertion', graceSetting)
    await recorder.refreshRuntimeSettings()
    const historyStarted = deferred<Record<string, unknown>>()
    harness.addHistory.mockImplementation((record: Record<string, unknown>) => {
      historyStarted.resolve(record)
      return Promise.resolve()
    })

    callbacks.onFinal?.(makeFinal())
    await expect(historyStarted.promise).resolves.toMatchObject({ llmText: 'recognized words' })
    await flushMicrotasks()

    expect(harness.addHistory).toHaveBeenCalledTimes(1)
    expect(harness.invoke.mock.calls.filter(([command]) => command === 'paste_text')).toHaveLength(expectedPasteCount)
    expect(Reflect.get(recorder, 'activeRunId')).toBe(0)
    expect(Reflect.get(recorder, 'finalizingLateRunId')).toBe(0)
  })

  it.each([
    { savedSetting: true, expectedPasteCount: 0 },
    { savedSetting: false, expectedPasteCount: 1 },
  ])('honors saved late-insertion setting $savedSetting after an unrelated refresh failure', async ({ savedSetting, expectedPasteCount }) => {
    const recorder = new RecorderOrchestrator()
    harness.settings.set('suppressLateFinalInsertion', !savedSetting)
    await recorder.refreshRuntimeSettings()

    harness.settings.set('suppressLateFinalInsertion', savedSetting)
    harness.unrelatedSettingsReadError = true
    await expect(recorder.refreshRuntimeSettings()).rejects.toThrow('microphone setting unavailable')
    harness.unrelatedSettingsReadError = false

    const callbacks = await enterTimeoutGrace(recorder, savedSetting ? 142 : 143, false)
    const historyWritten = deferred<Record<string, unknown>>()
    harness.addHistory.mockImplementation((record: Record<string, unknown>) => {
      historyWritten.resolve(record)
      return Promise.resolve()
    })

    callbacks.onFinal?.(makeFinal())
    await expect(historyWritten.promise).resolves.toMatchObject({ llmText: 'recognized words' })
    await flushMicrotasks()

    expect(harness.invoke.mock.calls.filter(([command]) => command === 'paste_text')).toHaveLength(expectedPasteCount)
    expect(Reflect.get(recorder, 'finalizingLateRunId')).toBe(0)
  })

  it('ignores a timed-out result after a new recording invalidates its grace context', async () => {
    harness.settings.set('suppressLateFinalInsertion', true)
    const recorder = new RecorderOrchestrator()
    const callbacks = await enterTimeoutGrace(recorder, 137)
    Reflect.set(recorder, 'cachedPresets', [{ id: 'intent', name: 'Intent', systemPrompt: '', builtin: true }])
    vi.stubGlobal('document', { activeElement: null, documentElement: { lang: '' } })
    vi.stubGlobal('HTMLElement', class { })
    const provider = await switchProvider('cloud_api')
    vi.spyOn(provider, 'isReady').mockReturnValue(true)
    vi.spyOn(provider, 'connect').mockResolvedValue(undefined)
    vi.spyOn(provider, 'start').mockReturnValue(true)
    const startRecording = Reflect.get(RecorderOrchestrator.prototype, 'startRecording') as (
      this: RecorderOrchestrator,
    ) => Promise<void>

    await startRecording.call(recorder)
    const newRunId = Reflect.get(recorder, 'activeRunId')
    expect(recorder.getState()).toBe('recording')
    expect(newRunId).not.toBe(137)

    callbacks.onFinal?.(makeFinal())
    await flushMicrotasks()

    expect(recorder.getState()).toBe('recording')
    expect(Reflect.get(recorder, 'activeRunId')).toBe(newRunId)
    expect(harness.addHistory).not.toHaveBeenCalled()
    expect(harness.invoke.mock.calls.filter(([command]) => command === 'paste_text')).toHaveLength(0)
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

describe('exclusive system-audio ownership', () => {
  it.each([
    ['startRecordingLock', true],
    ['activeRunId', 81],
    ['finalizingLateRunId', 82],
    ['textInsertionInFlight', true],
    ['timedOutProcessingContext', { runId: 83 }],
  ])('refuses subtitle acquisition while an idle recorder still owns %s', async (field, value) => {
    const recorder = new RecorderOrchestrator()
    Reflect.set(recorder, field, value)
    await expect(acquireSubtitles(recorder)).rejects.toThrow(en['systemAudio.busy'])
    expect(harness.invoke.mock.calls.some(([command]) => command === 'hide_overlay')).toBe(false)
  })

  it('clears an idle card and blocks microphone start and cleanup toasts while subtitles own the overlay', async () => {
    vi.stubGlobal('document', { activeElement: null, documentElement: { lang: '' } })
    vi.stubGlobal('HTMLElement', class {})
    const recorder = new RecorderOrchestrator()
    Reflect.set(recorder, 'cachedPresets', [{ id: 'intent', name: 'Intent', systemPrompt: '', builtin: true }])
    const overlay = Reflect.get(recorder, 'overlayService') as OverlayService
    overlay.showFailure({ cardToken: 84, failureTitle: 'Failed', failureDetail: 'Cause', failureRecovery: 'none' })
    Reflect.set(recorder, 'activeFallbackToken', 84)
    await acquireSubtitles(recorder)
    const provider = await switchProvider('cloud_api')
    await provider.connect({})
    harness.invoke.mockClear()
    recorder.showAiEnabledToast(true)
    const start = Reflect.get(recorder, 'startRecording') as () => Promise<void>
    await start.call(recorder)
    await vi.advanceTimersByTimeAsync(10_000)

    expect(harness.startCapture).not.toHaveBeenCalled()
    expect(overlayPayloads('present_overlay')).toEqual([])
    expect(harness.invoke.mock.calls.some(([command]) => command === 'hide_overlay')).toBe(false)
    expect(Reflect.get(recorder, 'activeFallbackToken')).toBe(0)
    recorder.cleanup()
  })

  it('ends subtitle ownership even when the dictation provider cannot reconnect', async () => {
    const recorder = new RecorderOrchestrator()
    await acquireSubtitles(recorder)
    const provider = await switchProvider('cloud_api')
    vi.spyOn(provider, 'connect').mockRejectedValue(new Error('server unreachable'))

    const release = Reflect.get(recorder, 'releaseSystemAudio') as () => Promise<void>
    await expect(release.call(recorder)).resolves.toBeUndefined()

    expect(Reflect.get(recorder, 'subtitleModeActive')).toBe(false)
    expect(harness.runtimeEvents.mock.calls.some(([level, , message]) =>
      level === 'warn' && String(message).includes('reconnect after subtitles failed'))).toBe(true)
    recorder.cleanup()
  })
})
