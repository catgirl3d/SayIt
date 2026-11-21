// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  invoke: vi.fn(),
  emitter: vi.fn(),
  provider: {
    mode: 'server' as const,
    isReady: vi.fn(() => true),
    connect: vi.fn(async () => undefined),
    start: vi.fn((_options: unknown) => true),
    cancel: vi.fn(),
    disconnect: vi.fn(),
    sendAudio: vi.fn(),
  },
  startCapture: vi.fn(),
  stopCapture: vi.fn(),
  loadSelectionAiConfig: vi.fn(),
  recordingContext: {
    appContext: null,
    probe: { editable: true, hwnd: '0x1', process: 'Editor', detail: 'editable' },
  },
}))

vi.mock('@/services/store', () => ({
  addHistory: vi.fn(async () => undefined),
  deleteHistory: vi.fn(async () => undefined),
  getActivePresetId: vi.fn(async () => 'intent'),
  getPromptPresets: vi.fn(async () => [{ id: 'intent', name: 'Intent', systemPrompt: 'Base', builtin: true }]),
  getSetting: vi.fn(async (key: string, fallback: unknown) => (
    harness.settings.has(key) ? harness.settings.get(key) : fallback
  )),
  recordUsage: vi.fn(async () => undefined),
  setActivePresetId: vi.fn(async () => undefined),
  setSetting: vi.fn(async (key: string, value: unknown) => harness.settings.set(key, value)),
}))
vi.mock('@/services/audio', () => ({
  startCapture: (...args: unknown[]) => harness.startCapture(...args),
  stopCapture: () => harness.stopCapture(),
}))
vi.mock('@/services/audioFileService', () => ({ saveRecordingAudio: vi.fn() }))
vi.mock('@/services/personalization/store', () => ({
  getAppPromptRules: vi.fn(async () => []),
  getUserStats: vi.fn(async () => ({ totalWords: 0, totalSessions: 0, domainWords: {}, appUsageCount: {} })),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => harness.invoke(...args) }))
vi.mock('@tauri-apps/api/event', () => ({
  emit: (...args: unknown[]) => harness.emitter(...args),
  listen: vi.fn(async () => () => undefined),
}))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn() }))
vi.mock('@/services/debugLog', () => ({ addRuntimeEvent: vi.fn() }))
vi.mock('@/services/transcription', () => ({ getProvider: () => harness.provider }))
vi.mock('@/services/transcription/selectionAi', () => ({
  CONTEXT_SELECTION_AI_PROFILE_KEY: 'contextSelectionAiProfileId',
  loadSelectionAiConfig: (...args: unknown[]) => harness.loadSelectionAiConfig(...args),
}))

import { t } from '@/i18n'
import { WebSocketConnectError } from '@/services/runtimeConfig'
import { RecorderOrchestrator } from '../RecorderOrchestrator'

type CaptureResult = { label: string; deviceId: string; groupId: string }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function flushMicrotasks() {
  for (let index = 0; index < 10; index++) await Promise.resolve()
}

async function createRecorder() {
  const recorder = new RecorderOrchestrator()
  recorder.setFileTranscriptionAdmissionReady(true)
  await recorder.refreshRuntimeSettings()
  return recorder
}

function presentedOverlayErrors() {
  return harness.invoke.mock.calls
    .filter(([command]) => command === 'present_overlay')
    .map(([, args]) => (args as { data: Record<string, unknown> }).data)
    .filter((data) => data.state === 'error')
}

beforeEach(() => {
  harness.settings.clear()
  harness.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === 'get_recording_context') return harness.recordingContext
    if (command === 'get_mic_mute_state') return { matched: false, muted: false }
    return 1
  })
  harness.provider.isReady.mockReset().mockReturnValue(true)
  harness.provider.connect.mockReset().mockResolvedValue(undefined)
  harness.provider.start.mockReset().mockReturnValue(true)
  harness.provider.cancel.mockReset()
  harness.startCapture.mockReset().mockResolvedValue({ label: 'Microphone', deviceId: 'd1', groupId: 'g1' })
  harness.stopCapture.mockReset().mockResolvedValue(undefined)
  harness.loadSelectionAiConfig.mockReset().mockResolvedValue(null)
})

describe('recording start when the connection fails while the microphone is still opening', () => {
  it('waits for the pending capture before stopping it, then shows the start error and releases the lock', async () => {
    const capture = deferred<CaptureResult>()
    harness.startCapture.mockReturnValueOnce(capture.promise)
    harness.provider.connect.mockRejectedValueOnce(new WebSocketConnectError('closed before open'))
    const recorder = await createRecorder()

    const starting = recorder.startRecording()
    await vi.waitFor(() => expect(harness.startCapture).toHaveBeenCalledTimes(1))
    await flushMicrotasks()

    expect(harness.stopCapture).not.toHaveBeenCalled()

    capture.resolve({ label: 'Microphone', deviceId: 'd1', groupId: 'g1' })
    await starting

    expect(harness.stopCapture).toHaveBeenCalledTimes(1)
    expect(harness.provider.start).not.toHaveBeenCalled()
    expect(presentedOverlayErrors()).toContainEqual(
      expect.objectContaining({ errorMessage: t('recorder.startFailed') }),
    )
    expect(recorder.testSeam().startRecordingLock).toBe(false)

    await recorder.startRecording()
    await vi.waitFor(() => expect(harness.provider.start).toHaveBeenCalledTimes(1))
  })
})
