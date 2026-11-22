// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  invoke: vi.fn(),
  emitter: vi.fn(),
  addRuntimeEvent: vi.fn(),
  provider: {
    mode: 'server' as const,
    isReady: vi.fn(() => true),
    connect: vi.fn(async (): Promise<void> => undefined),
    start: vi.fn((_options: unknown) => true),
    cancel: vi.fn(),
    disconnect: vi.fn(),
    sendAudio: vi.fn(),
  },
  startCapture: vi.fn(),
  stopCapture: vi.fn(),
  listCaptureEndpoints: vi.fn(),
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
vi.mock('@/services/debugLog', () => ({ addRuntimeEvent: harness.addRuntimeEvent }))
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
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function waitForStartFailure() {
  return vi.waitFor(() => expect(harness.addRuntimeEvent).toHaveBeenCalledWith(
    'error', 'recorder', 'Failed to start recording', expect.objectContaining({ error: expect.stringContaining('closed before open') }),
  ))
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
  harness.addRuntimeEvent.mockClear()
  harness.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === 'get_recording_context') return harness.recordingContext
    if (command === 'get_mic_mute_state') return { matched: false, muted: false }
    if (command === 'list_capture_endpoints') return harness.listCaptureEndpoints()
    return 1
  })
  harness.provider.isReady.mockReset().mockReturnValue(true)
  harness.provider.connect.mockReset().mockResolvedValue(undefined)
  harness.provider.start.mockReset().mockReturnValue(true)
  harness.provider.cancel.mockReset()
  harness.startCapture.mockReset().mockResolvedValue({ label: 'Microphone', deviceId: 'd1', groupId: 'g1' })
  harness.stopCapture.mockReset().mockResolvedValue(undefined)
  harness.listCaptureEndpoints.mockReset().mockResolvedValue([])
  harness.loadSelectionAiConfig.mockReset().mockResolvedValue(null)
})

describe('recording start when the connection fails during capture setup', () => {
  it('waits for the pending capture before stopping it, then shows the start error and releases the lock', async () => {
    const capture = deferred<CaptureResult>()
    const connection = deferred<void>()
    harness.startCapture.mockReturnValueOnce(capture.promise)
    harness.provider.connect.mockReturnValueOnce(connection.promise)
    const recorder = await createRecorder()

    const starting = recorder.startRecording()
    try {
      await vi.waitFor(() => expect(harness.startCapture).toHaveBeenCalledTimes(1))
      connection.reject(new WebSocketConnectError('closed before open'))
      await waitForStartFailure()

      expect(harness.stopCapture).not.toHaveBeenCalled()
      expect(recorder.testSeam().startRecordingLock).toBe(true)

      capture.resolve({ label: 'Microphone', deviceId: 'd1', groupId: 'g1' })
      await starting

      expect(harness.stopCapture).toHaveBeenCalledTimes(1)
      expect(harness.provider.start).not.toHaveBeenCalled()
      expect(presentedOverlayErrors()).toContainEqual(
        expect.objectContaining({ errorMessage: t('recorder.startFailed') }),
      )
      expect(recorder.testSeam().startRecordingLock).toBe(false)

      await recorder.startRecording()
      expect(harness.provider.start).toHaveBeenCalledTimes(1)
    } finally {
      connection.resolve(undefined)
      capture.resolve({ label: 'Microphone', deviceId: 'd1', groupId: 'g1' })
      await starting
      recorder.cleanup()
    }
  })

  it('does not overlap capture stops or open the replacement after a disconnect during probe cleanup', async () => {
    const connection = deferred<void>()
    const closingProbe = deferred<void>()
    const virtual = { name: 'CABLE Output', enumerator: 'ROOT', isDefault: true, isDefaultCommunications: false, isVirtual: true }
    const physical = { name: 'USB Microphone', enumerator: 'USB', isDefault: false, isDefaultCommunications: true, isVirtual: false }
    harness.listCaptureEndpoints.mockResolvedValue([virtual, physical])
    harness.startCapture.mockResolvedValueOnce({ label: virtual.name, deviceId: 'default', groupId: 'cable' })
    harness.stopCapture.mockReturnValueOnce(closingProbe.promise)
    harness.provider.connect.mockReturnValueOnce(connection.promise)
    vi.stubGlobal('navigator', {
      mediaDevices: {
        enumerateDevices: vi.fn().mockResolvedValueOnce([]).mockResolvedValue([
          { kind: 'audioinput', deviceId: 'usb-mic', groupId: 'usb', label: physical.name, toJSON: () => ({}) },
        ]),
      },
    })

    const recorder = await createRecorder()
    const starting = recorder.startRecording()
    try {
      await vi.waitFor(() => expect(harness.stopCapture).toHaveBeenCalledTimes(1))
      connection.reject(new WebSocketConnectError('closed before open'))
      await waitForStartFailure()
      expect(harness.stopCapture).toHaveBeenCalledTimes(1)

      closingProbe.resolve(undefined)
      await starting
      expect(harness.startCapture).toHaveBeenCalledTimes(1)
      expect(harness.provider.start).not.toHaveBeenCalled()
      expect(recorder.testSeam().startRecordingLock).toBe(false)
    } finally {
      connection.resolve(undefined)
      closingProbe.resolve(undefined)
      await starting
      recorder.cleanup()
      vi.unstubAllGlobals()
    }
  })
})
