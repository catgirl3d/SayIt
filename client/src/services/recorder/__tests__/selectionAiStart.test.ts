// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  events: new Map<string, (event: { payload: unknown }) => void>(),
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
  captureEndpoints: vi.fn(),
  loadSelectionAiConfig: vi.fn(),
  runtimeEvents: [] as unknown[][],
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
      textContextDiag: {
        result: 'captured',
        depth: 1,
        elapsedMs: 12,
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
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    harness.events.set(name, handler)
    return () => harness.events.delete(name)
  },
}))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn() }))
vi.mock('@/services/debugLog', () => ({
  addRuntimeEvent: (...args: unknown[]) => harness.runtimeEvents.push(args),
}))
vi.mock('@/services/transcription', () => ({ getProvider: () => harness.provider }))
vi.mock('@/services/transcription/selectionAi', () => ({
  CONTEXT_SELECTION_AI_PROFILE_KEY: 'contextSelectionAiProfileId',
  loadSelectionAiConfig: (...args: unknown[]) => harness.loadSelectionAiConfig(...args),
}))

import { RecorderOrchestrator } from '../RecorderOrchestrator'
import type { CaptureEndpoint } from '@/services/micRouting'

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
  harness.events.clear()
  harness.settings.set('aiEnabled', true)
  harness.settings.set('contextAwareWritingEnabled', true)
  harness.runtimeEvents.length = 0
  harness.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === 'get_recording_context') return harness.recordingContext
    if (command === 'get_mic_mute_state') return { matched: false, muted: false }
    if (command === 'list_capture_endpoints') return harness.captureEndpoints()
    return 1
  })
  harness.provider.isReady.mockReset().mockReturnValue(true)
  harness.provider.connect.mockReset().mockResolvedValue(undefined)
  harness.provider.start.mockReset().mockReturnValue(true)
  harness.provider.cancel.mockClear()
  harness.provider.sendAudio.mockClear()
  harness.startCapture.mockReset().mockResolvedValue({ label: 'Microphone', deviceId: 'd1', groupId: 'g1' })
  harness.stopCapture.mockReset().mockResolvedValue(undefined)
  harness.captureEndpoints.mockReset().mockResolvedValue([])
  harness.loadSelectionAiConfig.mockReset().mockResolvedValue(snapshot)
})

afterEach(() => vi.unstubAllGlobals())

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

  it('records the text-context result on Recording started without editor text', async () => {
    const recorder = await createRecorder()
    await recorder.startRecording()
    await vi.waitFor(() => expect(harness.provider.start).toHaveBeenCalledTimes(1))

    const started = harness.runtimeEvents.find(([, , message]) => message === 'Recording started')
    expect(started).toBeDefined()
    const detail = started?.[3] as { textContext?: Record<string, unknown> }
    expect(detail.textContext).toEqual({
      result: 'captured',
      kind: 'selection',
      source: 'uia',
      beforeLen: 'prefix'.length,
      selectedLen: 'Original selection'.length,
      afterLen: 'suffix'.length,
      depth: 1,
      elapsedMs: 12,
    })
    expect(JSON.stringify(detail.textContext)).not.toContain('Original selection')
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

    // A subsequent recording must start normally after the previous run was invalidated.
    harness.loadSelectionAiConfig.mockResolvedValue(snapshot)
    const recovered = await createRecorder()
    await recovered.startRecording()
    await vi.waitFor(() => expect(harness.provider.start).toHaveBeenCalledTimes(1))
    expect(harness.provider.start.mock.calls[0][0]).toMatchObject({ selectionAiConfig: snapshot })
  })
})

describe('recording microphone routing', () => {
  const cable = 'CABLE Output'
  const physical = { name: 'USB Microphone', enumerator: 'USB', isVirtual: false, isDefault: false, isDefaultCommunications: true }
  const virtual = { name: cable, enumerator: 'ROOT', isVirtual: true, isDefault: true, isDefaultCommunications: false }

  it('does not open a microphone while cleaning up a failed provider connection', async () => {
    const endpoints = deferred<CaptureEndpoint[]>()
    const cleanup = deferred<void>()
    harness.captureEndpoints.mockReturnValueOnce(endpoints.promise)
    harness.provider.connect.mockRejectedValueOnce(new Error('provider offline'))
    harness.stopCapture.mockReturnValueOnce(cleanup.promise)

    const recorder = await createRecorder()
    const starting = recorder.startRecording()
    await vi.waitFor(() => expect(harness.stopCapture).toHaveBeenCalledTimes(1))
    endpoints.resolve([])
    // Drain the IPC continuation before releasing the pending stop.
    await new Promise<void>((done) => setTimeout(done, 0))
    cleanup.resolve(undefined)
    await starting

    expect(harness.startCapture).not.toHaveBeenCalled()
    expect(harness.provider.start).not.toHaveBeenCalled()
  })

  it('queues PTT release while the input is being resolved', async () => {
    const endpoints = deferred<CaptureEndpoint[]>()
    harness.captureEndpoints.mockReturnValueOnce(endpoints.promise)

    const recorder = await createRecorder()
    await recorder.init()
    harness.events.get('ptt-down')!({ payload: null })
    await vi.waitFor(() => expect(harness.captureEndpoints).toHaveBeenCalledTimes(1))
    harness.events.get('ptt-up')!({ payload: null })
    endpoints.resolve([])

    try {
      await vi.waitFor(() => expect(harness.stopCapture).toHaveBeenCalledTimes(1))
      expect(harness.provider.start).toHaveBeenCalledTimes(1)
      expect(harness.provider.start.mock.invocationCallOrder[0]).toBeLessThan(harness.stopCapture.mock.invocationCallOrder[0])
    } finally {
      recorder.cleanup()
    }
  })

  it.each([
    { openedLabel: cable, expectedIds: [undefined, 'usb-mic'] },
    { openedLabel: physical.name, expectedIds: [undefined] },
  ])('retries only when the opened default track is the virtual endpoint: $openedLabel', async ({ openedLabel, expectedIds }) => {
    harness.captureEndpoints.mockResolvedValue([virtual, physical])
    vi.stubGlobal('navigator', {
      mediaDevices: {
        enumerateDevices: async () => harness.startCapture.mock.calls.length === 0 ? [] : [{
          deviceId: 'usb-mic', groupId: 'usb', kind: 'audioinput', label: physical.name,
        }],
      },
    })
    harness.startCapture.mockImplementationOnce(async (_id, onData: (buffer: ArrayBuffer) => void) => {
      onData(new ArrayBuffer(2))
      return { deviceId: 'default', groupId: 'default', label: openedLabel }
    })

    const recorder = await createRecorder()
    try {
      await recorder.startRecording()
      expect(harness.startCapture.mock.calls.map(([id]) => id)).toEqual(expectedIds)
      expect(harness.provider.start).toHaveBeenCalledTimes(1)
      expect(harness.provider.sendAudio).not.toHaveBeenCalled()
    } finally {
      recorder.cleanup()
    }
  })

  it('does not use the virtual default mute flag for its physical replacement', async () => {
    const physicalMute = deferred<{ matched: boolean; muted: boolean }>()
    const invoke = harness.invoke.getMockImplementation()!
    harness.invoke.mockImplementation((command: string, args?: { deviceLabel?: string | null }) => {
      if (command !== 'get_mic_mute_state') return invoke(command, args)
      if (args?.deviceLabel === null) return Promise.resolve({ matched: true, muted: true })
      return physicalMute.promise
    })
    harness.captureEndpoints.mockResolvedValue([virtual, physical])
    harness.startCapture.mockResolvedValue({ deviceId: 'usb-mic', groupId: 'usb', label: physical.name })
    vi.stubGlobal('navigator', {
      mediaDevices: {
        enumerateDevices: async () => [
          { deviceId: 'default', groupId: 'cable', kind: 'audioinput', label: `Default - ${cable}` },
          { deviceId: 'usb-mic', groupId: 'usb', kind: 'audioinput', label: physical.name },
        ],
      },
    })

    const recorder = await createRecorder()
    try {
      await recorder.startRecording()
      expect(harness.startCapture).toHaveBeenCalledWith('usb-mic', expect.any(Function), undefined, expect.any(Function), true)
      const onFrame: (frame: Int16Array) => void = harness.startCapture.mock.calls[0][3]
      onFrame(new Int16Array(4800))
      expect(harness.invoke.mock.calls).not.toContainEqual([
        'update_overlay_state', expect.objectContaining({ data: expect.objectContaining({ warning: 'Microphone is muted' }) }),
      ])
    } finally {
      physicalMute.resolve({ matched: true, muted: false })
      recorder.cleanup()
    }
  })

  it.each([false, true])('remembers a physical input only after a half-second of normal PCM (system muted: %s)', async (muted) => {
    harness.captureEndpoints.mockResolvedValue([physical])
    harness.startCapture.mockResolvedValue({ deviceId: 'usb-mic', groupId: 'usb', label: physical.name })
    if (muted) {
      const invoke = harness.invoke.getMockImplementation()!
      harness.invoke.mockImplementation((command: string, ...args: unknown[]) => command === 'get_mic_mute_state'
        ? Promise.resolve({ matched: true, muted: true })
        : invoke(command, ...args))
    }

    const recorder = await createRecorder()
    try {
      await recorder.startRecording()
      const onFrame: (frame: Int16Array) => void = harness.startCapture.mock.calls[0][3]
      if (muted) onFrame(new Int16Array(4800))
      onFrame(new Int16Array(7999).fill(1000))
      await Promise.resolve()
      expect(harness.settings.has('micLastGoodDevice')).toBe(false)

      onFrame(new Int16Array([1000]))
      await vi.waitFor(() => expect(harness.settings.get('micLastGoodDevice')).toBe('usb microphone'))
    } finally {
      recorder.cleanup()
    }
  })
})
