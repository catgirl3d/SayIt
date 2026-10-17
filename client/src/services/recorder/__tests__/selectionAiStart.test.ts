// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  invoke: vi.fn(),
  emitter: vi.fn(),
  provider: {
    mode: 'local' as const,
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
    appContext: {
      processName: 'Code.exe',
      windowTitle: 'SayIt.ts - Code',
      windowClass: 'Editor',
      textContext: {
        source: 'uia',
        textBefore: 'prefix',
        selectedText: 'Original selection',
        textAfter: 'suffix',
        selectionTruncated: false,
      },
    },
    probe: { editable: true, hwnd: '0x1', process: 'Code.exe', detail: 'editable' },
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

import { RecorderOrchestrator } from '../RecorderOrchestrator'

const snapshot = {
  provider: 'openai',
  apiUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-edit',
  model: 'gpt-edit',
  reasoningEffort: 'high',
  serviceTier: 'priority',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function createRecorder() {
  const recorder = new RecorderOrchestrator()
  recorder.setFileTranscriptionAdmissionReady(true)
  await recorder.refreshRuntimeSettings()
  return recorder
}

beforeEach(() => {
  harness.settings.clear()
  harness.settings.set('aiEnabled', true)
  harness.settings.set('contextAwareWritingEnabled', true)
  harness.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === 'get_recording_context') return harness.recordingContext
    if (command === 'get_mic_mute_state') return { matched: false, muted: false }
    return 1
  })
  harness.provider.isReady.mockReset().mockReturnValue(true)
  harness.provider.connect.mockReset().mockResolvedValue(undefined)
  harness.provider.start.mockReset().mockReturnValue(true)
  harness.startCapture.mockReset().mockResolvedValue({ label: 'Microphone', deviceId: 'd1', groupId: 'g1' })
  harness.stopCapture.mockReset().mockResolvedValue(undefined)
  harness.loadSelectionAiConfig.mockReset().mockResolvedValue(snapshot)
})

describe('selection-edit service freeze at recording start', () => {
  it('loads the snapshot against the captured selection and passes it to the provider', async () => {
    const recorder = await createRecorder()
    await recorder.startRecording()
    await vi.waitFor(() => expect(harness.provider.start).toHaveBeenCalledTimes(1))

    expect(harness.loadSelectionAiConfig).toHaveBeenCalledWith(expect.objectContaining({
      selectedText: 'Original selection',
      textBefore: 'prefix',
      textAfter: 'suffix',
    }))
    expect(harness.provider.start.mock.calls[0][0]).toMatchObject({
      selectionAiConfig: snapshot,
      textContext: expect.objectContaining({ selectedText: 'Original selection' }),
    })
  })

  it('skips the service lookup entirely while AI cleanup is off', async () => {
    harness.settings.set('aiEnabled', false)
    const recorder = await createRecorder()
    await recorder.startRecording()
    await vi.waitFor(() => expect(harness.provider.start).toHaveBeenCalledTimes(1))

    expect(harness.loadSelectionAiConfig).not.toHaveBeenCalled()
    expect(harness.provider.start.mock.calls[0][0]).toMatchObject({ selectionAiConfig: null })
  })

  it('keeps the dictation route when no selection service is chosen', async () => {
    harness.loadSelectionAiConfig.mockResolvedValue(null)
    const recorder = await createRecorder()
    await recorder.startRecording()
    await vi.waitFor(() => expect(harness.provider.start).toHaveBeenCalledTimes(1))

    expect(harness.provider.start.mock.calls[0][0]).toMatchObject({ selectionAiConfig: null })
  })

  it('never starts the provider when the run is invalidated while the snapshot loads', async () => {
    const pending = deferred<typeof snapshot | null>()
    harness.loadSelectionAiConfig.mockImplementation(() => pending.promise)
    const recorder = await createRecorder()
    const starting = recorder.startRecording()
    await vi.waitFor(() => expect(harness.loadSelectionAiConfig).toHaveBeenCalledTimes(1))

    recorder.testSeam().activeRunId = 9001
    pending.resolve(snapshot)
    await starting

    expect(harness.provider.start).not.toHaveBeenCalled()
    expect(harness.startCapture).not.toHaveBeenCalled()

    // A subsequent recording must start normally. The stale path here is not reachable
    // through today's public API (cancel is state-gated, supersession is blocked by the
    // start lock); this proves the harness still supports a full second start.
    harness.loadSelectionAiConfig.mockResolvedValue(snapshot)
    const recovered = await createRecorder()
    await recovered.startRecording()
    await vi.waitFor(() => expect(harness.provider.start).toHaveBeenCalledTimes(1))
    expect(harness.provider.start.mock.calls[0][0]).toMatchObject({ selectionAiConfig: snapshot })
  })
})
