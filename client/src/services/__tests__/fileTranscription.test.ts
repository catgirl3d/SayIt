import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FileTranscriptionService,
  type FileTranscriptionBridge,
  type FileTranscriptionSnapshot,
} from '../fileTranscription'

const profileStoreMocks = vi.hoisted(() => ({
  loadAsrProfiles: vi.fn(),
}))

const speechLanguageMocks = vi.hoisted(() => ({
  getSpeechInputLanguage: vi.fn(),
}))

const storeMocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
}))

vi.mock('@/features/settings/asrProfileStore', () => ({
  loadAsrProfiles: profileStoreMocks.loadAsrProfiles,
}))

vi.mock('@/services/store', async (importOriginal) => ({
  ...(await importOriginal()),
  getSetting: storeMocks.getSetting,
}))

vi.mock('../speechInputLanguage', async (importOriginal) => ({
  ...(await importOriginal()),
  getSpeechInputLanguage: speechLanguageMocks.getSpeechInputLanguage,
}))

const cloudProfile = {
  id: 'cloud-a',
  provider: 'groq_whisper',
  model: 'whisper-large-v3',
  apiKey: 'cloud-key',
  appId: '',
  console: 'new' as const,
  otherKey: '',
  workspaceId: '',
  omniPrompt: '',
}

function snapshot(overrides: Partial<FileTranscriptionSnapshot> = {}): FileTranscriptionSnapshot {
  return {
    jobId: 'job-1',
    sequence: 1,
    phase: 'transcribing',
    engine: 'local',
    cloudLabel: null,
    durationMs: 120_000,
    processedMs: 60_000,
    savedMs: 60_000,
    text: 'Saved text',
    draftPath: 'C:/output/job-1.partial.txt',
    txtPath: null,
    markdownPath: null,
    error: null,
    warning: null,
    retryableExport: false,
    resourcesReleased: false,
    ...overrides,
  }
}

function createHarness() {
  const calls: string[] = []
  const invoke = vi.fn(async (command: string, _args?: Record<string, unknown>): Promise<unknown> => {
    calls.push(`invoke:${command}`)
    if (command === 'get_file_transcription_state') return null
    return undefined
  })
  const listen = vi.fn(async (_event: string, _handler: (event: { payload: unknown }) => void): Promise<() => void> => {
    calls.push('listen:file-transcription-state')
    return () => undefined
  })
  const admission = {
    reserveFileTranscription: vi.fn(() => calls.push('reserve')),
    releaseFileTranscription: vi.fn(() => calls.push('release')),
    setFileTranscriptionAdmissionReady: vi.fn(),
  }
  const bridge = { invoke, listen } as unknown as FileTranscriptionBridge
  return { calls, invoke, listen, admission, bridge }
}

describe('file transcription service', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    profileStoreMocks.loadAsrProfiles.mockResolvedValue({ profiles: [cloudProfile], activeId: cloudProfile.id })
    speechLanguageMocks.getSpeechInputLanguage.mockResolvedValue('uk')
    storeMocks.getSetting.mockImplementation(async (_key: string, fallback: unknown) => fallback)
  })

  it('returns cloud profile display metadata without exposing credentials', async () => {
    const harness = createHarness()
    const service = new FileTranscriptionService(harness.bridge, harness.admission)

    await expect(service.getCloudProfiles()).resolves.toEqual({
      profiles: [{
        id: 'cloud-a',
        label: 'Groq Whisper',
        provider: 'groq_whisper',
        model: 'whisper-large-v3',
      }],
      activeId: 'cloud-a',
    })
  })

  it('keeps local request fields and marks the IPC request as local', async () => {
    const harness = createHarness()
    harness.invoke.mockImplementation(async (command: string) => {
      if (command === 'start_file_transcription') return snapshot({ resourcesReleased: true })
      return command === 'get_file_transcription_state' ? null : undefined
    })
    const service = new FileTranscriptionService(harness.bridge, harness.admission)

    await service.start({
      filePath: 'C:/recording.mp4',
      outputDirectory: 'C:/output',
      ffmpegDirectory: null,
      audioStreamIndex: null,
      modelId: 'sensevoice-small-gguf',
      language: 'en',
      accelerator: 'auto',
    })

    expect(harness.invoke).toHaveBeenCalledWith('start_file_transcription', {
      request: {
        filePath: 'C:/recording.mp4',
        outputDirectory: 'C:/output',
        ffmpegDirectory: null,
        audioStreamIndex: null,
        modelId: 'sensevoice-small-gguf',
        language: 'en',
        accelerator: 'auto',
        engine: 'local',
        cloud: null,
      },
    })
  })

  it('builds a cloud request from a fixed profile snapshot and does not reserve local admission', async () => {
    const harness = createHarness()
    harness.invoke.mockImplementation(async (command: string) => {
      if (command === 'start_file_transcription') return snapshot({ engine: 'cloud', cloudLabel: 'Groq Whisper', resourcesReleased: true })
      if (command === 'list_available_models' || command === 'list_downloaded_models') return []
      return command === 'get_file_transcription_state' ? null : undefined
    })
    const service = new FileTranscriptionService(harness.bridge, harness.admission)

    await service.startWithCurrentSettings({
      filePath: 'C:/recording.mp4',
      outputDirectory: 'C:/output',
      ffmpegDirectory: null,
      audioStreamIndex: 2,
      engine: 'cloud',
      cloudProfileId: 'cloud-a',
    })

    const startCall = harness.invoke.mock.calls.find(([command]) => command === 'start_file_transcription')
    const request = (startCall?.[1] as { request: Record<string, unknown> }).request
    expect(request).toEqual({
      filePath: 'C:/recording.mp4',
      outputDirectory: 'C:/output',
      ffmpegDirectory: null,
      audioStreamIndex: 2,
      engine: 'cloud',
      language: 'uk',
      cloud: {
        label: 'Groq Whisper',
        config: {
          provider: 'groq_whisper',
          api_key: 'cloud-key',
          app_id: '',
          extra: { model: 'whisper-large-v3', language: 'uk' },
        },
      },
    })
    expect(request).not.toHaveProperty('modelId')
    expect(request).toHaveProperty('language', 'uk')
    expect(request).not.toHaveProperty('accelerator')
    expect(harness.admission.reserveFileTranscription).not.toHaveBeenCalled()
  })

  it('detects an FFmpeg directory through the exact no-args IPC command', async () => {
    const harness = createHarness()
    harness.invoke.mockImplementation(async (command: string) => {
      if (command === 'detect_ffmpeg_directory') return 'C:/tools/ffmpeg'
      return command === 'get_file_transcription_state' ? null : undefined
    })
    const service = new FileTranscriptionService(harness.bridge, harness.admission)

    await expect(service.detectFfmpegDirectory()).resolves.toBe('C:/tools/ffmpeg')

    expect(harness.invoke).toHaveBeenCalledWith('detect_ffmpeg_directory')
  })

  it('subscribes before querying and restores an active native snapshot', async () => {
    const harness = createHarness()
    harness.invoke.mockImplementation(async (command: string) => {
      harness.calls.push(`invoke:${command}`)
      return command === 'get_file_transcription_state' ? snapshot() : undefined
    })
    const service = new FileTranscriptionService(harness.bridge, harness.admission)

    await service.init()

    expect(harness.calls.slice(0, 3)).toEqual([
      'listen:file-transcription-state',
      'invoke:get_file_transcription_state',
      'reserve',
    ])
    expect(service.getSnapshot()).toEqual(snapshot())
    expect(harness.admission.reserveFileTranscription).toHaveBeenCalledTimes(1)
  })

  it('restores an active cloud snapshot without reserving local admission', async () => {
    const harness = createHarness()
    harness.invoke.mockImplementation(async (command: string) => {
      return command === 'get_file_transcription_state'
        ? snapshot({ engine: 'cloud', cloudLabel: 'Groq Whisper' })
        : undefined
    })
    const service = new FileTranscriptionService(harness.bridge, harness.admission)

    await service.init()

    expect(service.getSnapshot()).toEqual(snapshot({ engine: 'cloud', cloudLabel: 'Groq Whisper' }))
    expect(harness.admission.reserveFileTranscription).not.toHaveBeenCalled()
  })

  it('keeps initialization failures visible while re-opening admission for local capture', async () => {
    const harness = createHarness()
    harness.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_file_transcription_state') throw new Error('state query failed')
      return undefined
    })
    const service = new FileTranscriptionService(harness.bridge, harness.admission)

    await expect(service.init()).rejects.toThrow('state query failed')

    expect(service.getInitializationError()).toBe('state query failed')
    expect(harness.admission.reserveFileTranscription).not.toHaveBeenCalled()
    expect(harness.admission.setFileTranscriptionAdmissionReady).toHaveBeenNthCalledWith(1, false)
    expect(harness.admission.setFileTranscriptionAdmissionReady).toHaveBeenLastCalledWith(true)
  })

  it('reserves before start IPC and releases only when the start request fails', async () => {
    const harness = createHarness()
    harness.invoke.mockImplementation(async (command: string) => {
      harness.calls.push(`invoke:${command}`)
      if (command === 'start_file_transcription') throw new Error('native start failed')
      return command === 'get_file_transcription_state' ? null : undefined
    })
    const service = new FileTranscriptionService(harness.bridge, harness.admission)

    await expect(service.start({
      filePath: 'C:/recording.mp4',
      outputDirectory: 'C:/output',
      ffmpegDirectory: null,
      audioStreamIndex: null,
      modelId: 'sensevoice-small-gguf',
      language: 'en',
      accelerator: 'auto',
    })).rejects.toThrow('native start failed')

    expect(harness.calls.indexOf('reserve')).toBeLessThan(harness.calls.indexOf('invoke:start_file_transcription'))
    expect(harness.calls.indexOf('invoke:start_file_transcription')).toBeLessThan(harness.calls.indexOf('release'))
    expect(harness.admission.releaseFileTranscription).toHaveBeenCalledTimes(1)
  })

  it('keeps the native reservation for a failed snapshot until resources are released', async () => {
    const harness = createHarness()
    let stateHandler: ((event: { payload: FileTranscriptionSnapshot }) => void) | undefined
    harness.listen.mockImplementation(async (_event, handler) => {
      stateHandler = handler as (event: { payload: FileTranscriptionSnapshot }) => void
      return () => undefined
    })
    harness.invoke.mockImplementation(async (command: string) => {
      if (command === 'start_file_transcription') return snapshot({ phase: 'failed', error: 'checkpoint failed' })
      return command === 'get_file_transcription_state' ? null : undefined
    })
    const service = new FileTranscriptionService(harness.bridge, harness.admission)

    await service.start({
      filePath: 'C:/recording.mp4',
      outputDirectory: 'C:/output',
      ffmpegDirectory: null,
      audioStreamIndex: null,
      modelId: 'sensevoice-small-gguf',
      language: 'en',
      accelerator: 'auto',
    })

    expect(harness.admission.releaseFileTranscription).not.toHaveBeenCalled()
    stateHandler?.({ payload: snapshot({ sequence: 2, phase: 'failed', resourcesReleased: true }) })
    expect(harness.admission.releaseFileTranscription).toHaveBeenCalledTimes(1)
  })

  it('releases the reservation when a failed worker start publishes its terminal snapshot', async () => {
    const harness = createHarness()
    let stateHandler: ((event: { payload: FileTranscriptionSnapshot }) => void) | undefined
    harness.listen.mockImplementation(async (_event, handler) => {
      stateHandler = handler as (event: { payload: FileTranscriptionSnapshot }) => void
      return () => undefined
    })
    let rejectStart: (error: Error) => void = () => undefined
    let startInvoked: () => void = () => undefined
    const startCalled = new Promise<void>((resolve) => { startInvoked = resolve })
    harness.invoke.mockImplementation((command: string) => {
      if (command === 'start_file_transcription') {
        startInvoked()
        return new Promise((_resolve, reject) => { rejectStart = reject })
      }
      return Promise.resolve(command === 'get_file_transcription_state' ? null : undefined)
    })
    const service = new FileTranscriptionService(harness.bridge, harness.admission)
    await service.init()

    const startPromise = service.start({
      filePath: 'C:/recording.mp4',
      outputDirectory: 'C:/output',
      ffmpegDirectory: null,
      audioStreamIndex: null,
      modelId: 'sensevoice-small-gguf',
      language: 'en',
      accelerator: 'auto',
    })
    await startCalled
    stateHandler?.({ payload: snapshot({ sequence: 1 }) })
    stateHandler?.({ payload: snapshot({ sequence: 2, phase: 'failed', resourcesReleased: true, error: 'Failed to start file transcription worker' }) })
    rejectStart(new Error('Failed to start file transcription worker'))
    await expect(startPromise).rejects.toThrow('Failed to start file transcription worker')

    expect(harness.admission.releaseFileTranscription).toHaveBeenCalledTimes(1)
  })

  it('releases the reservation when the terminal snapshot arrives after the start rejection', async () => {
    const harness = createHarness()
    let stateHandler: ((event: { payload: FileTranscriptionSnapshot }) => void) | undefined
    harness.listen.mockImplementation(async (_event, handler) => {
      stateHandler = handler as (event: { payload: FileTranscriptionSnapshot }) => void
      return () => undefined
    })
    let rejectStart: (error: Error) => void = () => undefined
    let startInvoked: () => void = () => undefined
    const startCalled = new Promise<void>((resolve) => { startInvoked = resolve })
    harness.invoke.mockImplementation((command: string) => {
      if (command === 'start_file_transcription') {
        startInvoked()
        return new Promise((_resolve, reject) => { rejectStart = reject })
      }
      return Promise.resolve(command === 'get_file_transcription_state' ? null : undefined)
    })
    const service = new FileTranscriptionService(harness.bridge, harness.admission)
    await service.init()

    const startPromise = service.start({
      filePath: 'C:/recording.mp4',
      outputDirectory: 'C:/output',
      ffmpegDirectory: null,
      audioStreamIndex: null,
      modelId: 'sensevoice-small-gguf',
      language: 'en',
      accelerator: 'auto',
    })
    await startCalled
    stateHandler?.({ payload: snapshot({ sequence: 1 }) })
    rejectStart(new Error('Failed to start file transcription worker'))
    await expect(startPromise).rejects.toThrow('Failed to start file transcription worker')
    expect(harness.admission.releaseFileTranscription).not.toHaveBeenCalled()

    stateHandler?.({ payload: snapshot({ sequence: 2, phase: 'failed', resourcesReleased: true, error: 'Failed to start file transcription worker' }) })
    expect(harness.admission.releaseFileTranscription).toHaveBeenCalledTimes(1)
  })

  it('keeps the reservation when a rejected start never publishes a terminal snapshot', async () => {
    const harness = createHarness()
    let stateHandler: ((event: { payload: FileTranscriptionSnapshot }) => void) | undefined
    harness.listen.mockImplementation(async (_event, handler) => {
      stateHandler = handler as (event: { payload: FileTranscriptionSnapshot }) => void
      return () => undefined
    })
    let rejectStart: (error: Error) => void = () => undefined
    let startInvoked: () => void = () => undefined
    const startCalled = new Promise<void>((resolve) => { startInvoked = resolve })
    harness.invoke.mockImplementation((command: string) => {
      if (command === 'start_file_transcription') {
        startInvoked()
        return new Promise((_resolve, reject) => { rejectStart = reject })
      }
      return Promise.resolve(command === 'get_file_transcription_state' ? null : undefined)
    })
    const service = new FileTranscriptionService(harness.bridge, harness.admission)
    await service.init()

    const startPromise = service.start({
      filePath: 'C:/recording.mp4',
      outputDirectory: 'C:/output',
      ffmpegDirectory: null,
      audioStreamIndex: null,
      modelId: 'sensevoice-small-gguf',
      language: 'en',
      accelerator: 'auto',
    })
    await startCalled
    stateHandler?.({ payload: snapshot({ sequence: 1 }) })
    rejectStart(new Error('Failed to start file transcription worker'))
    await expect(startPromise).rejects.toThrow('Failed to start file transcription worker')

    expect(harness.admission.releaseFileTranscription).not.toHaveBeenCalled()
  })

  it('accepts a terminal cloud snapshot without releasing local admission', async () => {
    const harness = createHarness()
    let stateHandler: ((event: { payload: FileTranscriptionSnapshot }) => void) | undefined
    harness.listen.mockImplementation(async (_event, handler) => {
      stateHandler = handler as (event: { payload: FileTranscriptionSnapshot }) => void
      return () => undefined
    })
    harness.invoke.mockImplementation(async (command: string) => {
      if (command === 'start_file_transcription') return snapshot({ engine: 'cloud', cloudLabel: 'Groq Whisper' })
      return command === 'get_file_transcription_state' ? null : undefined
    })
    const service = new FileTranscriptionService(harness.bridge, harness.admission)

    await service.startWithCurrentSettings({
      filePath: 'C:/recording.mp4',
      outputDirectory: 'C:/output',
      ffmpegDirectory: null,
      audioStreamIndex: null,
      engine: 'cloud',
      cloudProfileId: 'cloud-a',
    })

    stateHandler?.({ payload: snapshot({
      engine: 'cloud',
      cloudLabel: 'Groq Whisper',
      sequence: 2,
      phase: 'completed',
      resourcesReleased: true,
    }) })

    expect(service.getSnapshot()?.phase).toBe('completed')
    expect(harness.admission.releaseFileTranscription).not.toHaveBeenCalled()
  })

  it('does not let an old job release the reservation of a newer active job', async () => {
    const harness = createHarness()
    let stateHandler: ((event: { payload: FileTranscriptionSnapshot }) => void) | undefined
    harness.listen.mockImplementation(async (_event, handler) => {
      stateHandler = handler as (event: { payload: FileTranscriptionSnapshot }) => void
      return () => undefined
    })
    const starts = [
      snapshot({ jobId: 'job-1', sequence: 1 }),
      snapshot({ jobId: 'job-2', sequence: 3 }),
    ]
    harness.invoke.mockImplementation(async (command: string) => {
      if (command === 'start_file_transcription') return starts.shift()
      return command === 'get_file_transcription_state' ? null : undefined
    })
    const service = new FileTranscriptionService(harness.bridge, harness.admission)

    await service.start({
      filePath: 'C:/one.mp4',
      outputDirectory: 'C:/output',
      ffmpegDirectory: null,
      audioStreamIndex: null,
      modelId: 'model',
      language: 'en',
      accelerator: 'auto',
    })
    stateHandler?.({ payload: snapshot({ jobId: 'job-1', sequence: 1, resourcesReleased: true, phase: 'failed' }) })
    expect(harness.admission.releaseFileTranscription).not.toHaveBeenCalled()
    stateHandler?.({ payload: snapshot({ jobId: 'job-1', sequence: 2, resourcesReleased: true, phase: 'failed' }) })
    await service.start({
      filePath: 'C:/two.mp4',
      outputDirectory: 'C:/output',
      ffmpegDirectory: null,
      audioStreamIndex: null,
      modelId: 'model',
      language: 'en',
      accelerator: 'auto',
    })

    stateHandler?.({ payload: snapshot({ jobId: 'job-1', sequence: 4, resourcesReleased: true, phase: 'failed' }) })
    expect(harness.admission.releaseFileTranscription).toHaveBeenCalledTimes(1)
    expect(service.getSnapshot()?.jobId).toBe('job-2')
  })

  it('dispose releases the state listener and reservation for a hot-replaced instance', async () => {
    const harness = createHarness()
    const unlisten = vi.fn()
    harness.listen.mockImplementation(async () => {
      harness.calls.push('listen:file-transcription-state')
      return unlisten
    })
    harness.invoke.mockImplementation(async (command: string) => {
      harness.calls.push(`invoke:${command}`)
      return command === 'get_file_transcription_state' ? snapshot() : undefined
    })
    const service = new FileTranscriptionService(harness.bridge, harness.admission)

    await service.init()
    expect(harness.admission.reserveFileTranscription).toHaveBeenCalledTimes(1)

    service.dispose()

    expect(unlisten).toHaveBeenCalledTimes(1)
    expect(service.getSnapshot()).toBeNull()
    expect(harness.admission.releaseFileTranscription).toHaveBeenCalledTimes(1)

    const reloaded = new FileTranscriptionService(harness.bridge, harness.admission)
    await reloaded.init()
    expect(reloaded.getSnapshot()).toEqual(snapshot())
    expect(harness.admission.reserveFileTranscription).toHaveBeenCalledTimes(2)
  })

  it('does not resurrect the service when disposed during a pending init', async () => {
    const harness = createHarness()
    let resolveListen: (unlisten: () => void) => void = () => undefined
    const unlisten = vi.fn()
    harness.listen.mockImplementation(
      () =>
        new Promise<() => void>((resolve) => {
          resolveListen = resolve
        }),
    )
    const service = new FileTranscriptionService(harness.bridge, harness.admission)

    const initPromise = service.init()
    service.dispose()
    resolveListen(unlisten)
    await initPromise

    expect(unlisten).toHaveBeenCalledTimes(1)
    expect(harness.admission.reserveFileTranscription).not.toHaveBeenCalled()
    expect(service.getSnapshot()).toBeNull()
    expect(service.getInitializationError()).toBeNull()
  })

  it('drops a late state event after dispose instead of reviving the instance', async () => {
    const harness = createHarness()
    let stateHandler: ((event: { payload: FileTranscriptionSnapshot }) => void) | undefined
    harness.listen.mockImplementation(async (_event, handler) => {
      stateHandler = handler as (event: { payload: FileTranscriptionSnapshot }) => void
      return () => undefined
    })
    harness.invoke.mockImplementation(async (command: string) =>
      command === 'get_file_transcription_state' ? snapshot({ sequence: 3 }) : undefined,
    )
    const service = new FileTranscriptionService(harness.bridge, harness.admission)

    await service.init()
    expect(harness.admission.reserveFileTranscription).toHaveBeenCalledTimes(1)
    service.dispose()
    expect(harness.admission.releaseFileTranscription).toHaveBeenCalledTimes(1)

    // The sequence is higher than the restored one, so only the epoch guard
    // can keep this snapshot from reviving the disposed instance.
    stateHandler?.({ payload: snapshot({ sequence: 9 }) })

    expect(service.getSnapshot()).toBeNull()
    expect(harness.admission.reserveFileTranscription).toHaveBeenCalledTimes(1)
  })

  it('starts a fresh init after dispose and does not adopt the abandoned operation', async () => {
    const harness = createHarness()
    let secondHandler: ((event: { payload: FileTranscriptionSnapshot }) => void) | undefined
    let resolveFirstListen: (unlisten: () => void) => void = () => undefined
    const firstUnlisten = vi.fn(() => undefined)
    let resolveState: (value: FileTranscriptionSnapshot | null) => void = () => undefined
    const stateQuery = new Promise<FileTranscriptionSnapshot | null>((resolve) => {
      resolveState = resolve
    })
    harness.listen
      .mockImplementationOnce(
        async () =>
          new Promise<() => void>((resolve) => {
            resolveFirstListen = resolve
          }),
      )
      .mockImplementationOnce(async (_event, handler) => {
        secondHandler = handler as (event: { payload: FileTranscriptionSnapshot }) => void
        return () => undefined
      })
    harness.invoke.mockImplementation(async (command: string) =>
      command === 'get_file_transcription_state' ? stateQuery : undefined,
    )
    const service = new FileTranscriptionService(harness.bridge, harness.admission)

    const firstInit = service.init()
    service.dispose()
    const secondInit = service.init()
    resolveFirstListen(firstUnlisten)
    await firstInit

    expect(firstUnlisten).toHaveBeenCalledTimes(1)
    expect(harness.listen).toHaveBeenCalledTimes(2)

    const pendingInit = service.init()
    expect(harness.listen).toHaveBeenCalledTimes(2)

    resolveState(snapshot({ sequence: 5 }))
    await Promise.all([secondInit, pendingInit])

    expect(service.getSnapshot()?.sequence).toBe(5)
    expect(harness.admission.setFileTranscriptionAdmissionReady).toHaveBeenLastCalledWith(true)

    secondHandler?.({ payload: snapshot({ sequence: 7 }) })
    expect(service.getSnapshot()?.sequence).toBe(7)
  })
})
