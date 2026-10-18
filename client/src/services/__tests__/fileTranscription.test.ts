import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  errorMessage,
  FileTranscriptionService,
  normalizeInspectionFailure,
  type FileTranscriptionBridge,
  type FileTranscriptionSnapshot,
} from '../fileTranscription'
import { DEFAULT_LOCAL_MODEL_ID } from '../localModelStatus'

const profileStoreMocks = vi.hoisted(() => ({
  loadAsrProfiles: vi.fn(),
}))

const speechLanguageMocks = vi.hoisted(() => ({
  getSpeechInputLanguage: vi.fn(),
}))

const storeMocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}))

vi.mock('@/features/settings/asrProfileStore', () => ({
  loadAsrProfiles: profileStoreMocks.loadAsrProfiles,
}))

vi.mock('@/services/store', async (importOriginal) => ({
  ...(await importOriginal()),
  getSetting: storeMocks.getSetting,
  setSetting: storeMocks.setSetting,
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
    if (command === 'list_downloaded_models') return []
    if (command === 'get_file_transcription_cloud_window_options') return []
    return undefined
  })
  const listen = vi.fn(async (_event: string, _handler: (event: { payload: unknown }) => void): Promise<() => void> => {
    calls.push('listen:file-transcription-state')
    return () => undefined
  })
  const copyText = vi.fn(async (_text: string): Promise<void> => {
    calls.push('copyText')
  })
  const admission = {
    reserveFileTranscription: vi.fn(() => calls.push('reserve')),
    releaseFileTranscription: vi.fn(() => calls.push('release')),
    setFileTranscriptionAdmissionReady: vi.fn(),
  }
  const bridge = { invoke, listen, copyText } as unknown as FileTranscriptionBridge
  return { calls, invoke, listen, copyText, admission, bridge }
}

describe('file transcription service', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    profileStoreMocks.loadAsrProfiles.mockResolvedValue({ profiles: [cloudProfile], activeId: cloudProfile.id })
    speechLanguageMocks.getSpeechInputLanguage.mockResolvedValue('uk')
    storeMocks.getSetting.mockImplementation(async (_key: string, fallback: unknown) => fallback)
    storeMocks.setSetting.mockResolvedValue(undefined)
  })

  it('returns cloud profile display metadata without exposing credentials', async () => {
    const harness = createHarness()
    const service = new FileTranscriptionService(harness.bridge, harness.admission)

    await expect(service.getCloudProfiles()).resolves.toEqual({
      profiles: [
        {
          id: 'cloud-a',
          label: 'Groq Whisper',
          provider: 'groq_whisper',
          model: 'whisper-large-v3',
          windowSecondsOptions: [],
          missing: '',
        },
      ],
      activeId: 'cloud-a',
    })
  })

  it('loads backend-provided cloud window options once per unique provider', async () => {
    const profiles = [
      cloudProfile,
      { ...cloudProfile, id: 'cloud-b', model: 'whisper-medium' },
      { ...cloudProfile, id: 'cloud-fixed', provider: 'fixed_provider' },
    ]
    profileStoreMocks.loadAsrProfiles.mockResolvedValue({ profiles, activeId: cloudProfile.id })
    const harness = createHarness()
    const windowOptionCalls: Array<{ provider: string }> = []
    harness.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'get_file_transcription_cloud_window_options') {
        windowOptionCalls.push(args as { provider: string })
        return args?.provider === 'groq_whisper' ? [300, 180] : []
      }
      return undefined
    })
    const service = new FileTranscriptionService(harness.bridge, harness.admission)

    await expect(service.getCloudProfiles()).resolves.toEqual({
      profiles: [
        expect.objectContaining({ id: 'cloud-a', windowSecondsOptions: [300, 180] }),
        expect.objectContaining({ id: 'cloud-b', windowSecondsOptions: [300, 180] }),
        expect.objectContaining({ id: 'cloud-fixed', windowSecondsOptions: [] }),
      ],
      activeId: 'cloud-a',
    })
    expect(windowOptionCalls).toEqual([{ provider: 'groq_whisper' }, { provider: 'fixed_provider' }])
  })

  it('marks unconfigured cloud profiles as missing and configured ones as ready', async () => {
    profileStoreMocks.loadAsrProfiles.mockResolvedValue({
      profiles: [
        cloudProfile,
        { ...cloudProfile, id: 'cloud-b', apiKey: '' },
        {
          ...cloudProfile,
          id: 'cloud-c',
          provider: 'openai_compat',
          baseUrl: 'ftp://asr.example.test/v1',
          model: 'local-model',
        },
      ],
      activeId: cloudProfile.id,
    })
    const harness = createHarness()
    const service = new FileTranscriptionService(harness.bridge, harness.admission)

    const { profiles } = await service.getCloudProfiles()

    expect(profiles.map(({ id, missing }) => ({ id, missing }))).toEqual([
      { id: 'cloud-a', missing: '' },
      { id: 'cloud-b', missing: 'no API key yet' },
      {
        id: 'cloud-c',
        missing: 'base URL must be a valid HTTP(S) URL without username or password, query, or fragment',
      },
    ])
  })

  it('loads only complete downloaded models with localized display names', async () => {
    const harness = createHarness()
    harness.invoke.mockImplementation(async (command: string) => {
      if (command === 'list_downloaded_models') {
        return [
          { id: 'sensevoice-small-gguf', name: 'Raw SenseVoice', complete: true },
          { id: 'incomplete-model', name: 'Incomplete', complete: false },
          { id: 'truthy-model', name: 'Truthy complete', complete: 'yes' as unknown as boolean },
          { id: 'custom-model', name: 'Custom model', complete: true },
        ]
      }
      return command === 'get_file_transcription_state' ? null : undefined
    })
    const service = new FileTranscriptionService(harness.bridge, harness.admission)

    await expect(service.loadJobOptions()).resolves.toMatchObject({
      models: [
        { id: 'sensevoice-small-gguf', name: 'SenseVoice Small' },
        { id: 'custom-model', name: 'Custom model' },
      ],
      modelId: 'sensevoice-small-gguf',
      modelsError: '',
    })
  })

  it('resolves the remembered model, global model, first model, and empty-list fallbacks', async () => {
    const load = async (
      rememberedModelId: string,
      globalModelId: string,
      downloaded: Array<{ id: string; name: string; complete: boolean }>,
    ) => {
      const harness = createHarness()
      harness.invoke.mockImplementation(async (command: string) => {
        if (command === 'list_downloaded_models') return downloaded
        return command === 'get_file_transcription_state' ? null : undefined
      })
      storeMocks.getSetting.mockImplementation(async (key: string, fallback: unknown) => {
        if (key === 'fileTranscription.modelId') return rememberedModelId
        if (key === 'localAsr.modelId') return globalModelId
        return fallback
      })
      const service = new FileTranscriptionService(harness.bridge, harness.admission)
      return service.loadJobOptions()
    }

    await expect(
      load('remembered', 'global', [
        { id: 'remembered', name: 'Remembered', complete: true },
        { id: 'global', name: 'Global', complete: true },
      ]),
    ).resolves.toMatchObject({ modelId: 'remembered' })
    await expect(
      load('gone', 'global', [
        { id: 'global', name: 'Global', complete: true },
        { id: 'first', name: 'First', complete: true },
      ]),
    ).resolves.toMatchObject({ modelId: 'global' })
    await expect(load('gone', 'missing', [{ id: 'first', name: 'First', complete: true }])).resolves.toMatchObject({
      modelId: 'first',
    })
    await expect(load('gone', 'missing', [])).resolves.toMatchObject({ modelId: '' })
  })

  it('keeps a remembered language including auto, and falls back to the global language when empty', async () => {
    const harness = createHarness()
    const service = new FileTranscriptionService(harness.bridge, harness.admission)
    storeMocks.getSetting.mockImplementation(async (key: string, fallback: unknown) => {
      if (key === 'fileTranscription.language') return 'auto'
      return fallback
    })

    await expect(service.loadJobOptions()).resolves.toMatchObject({ language: 'auto' })

    storeMocks.getSetting.mockImplementation(async (key: string, fallback: unknown) => {
      if (key === 'fileTranscription.language') return ''
      return fallback
    })
    await expect(service.loadJobOptions()).resolves.toMatchObject({ language: 'uk' })
  })

  it('restores a remembered cloud window value without normalizing it in the service loader', async () => {
    const harness = createHarness()
    storeMocks.getSetting.mockImplementation(async (key: string, fallback: unknown) => {
      if (key === 'fileTranscription.cloudWindowSeconds') return 180
      return fallback
    })
    const service = new FileTranscriptionService(harness.bridge, harness.admission)

    await expect(service.loadJobOptions()).resolves.toMatchObject({ cloudWindowSeconds: 180 })
  })

  it('resolves the remembered, active, first, and empty cloud profile fallbacks', async () => {
    const harness = createHarness()
    const service = new FileTranscriptionService(harness.bridge, harness.admission)
    const profiles = [cloudProfile, { ...cloudProfile, id: 'cloud-b', model: 'second-model' }]

    const load = async (remembered: string, activeId: string, availableProfiles = profiles) => {
      profileStoreMocks.loadAsrProfiles.mockResolvedValue({ profiles: availableProfiles, activeId })
      storeMocks.getSetting.mockImplementation(async (key: string, fallback: unknown) => {
        if (key === 'fileTranscription.cloudProfileId') return remembered
        return fallback
      })
      return service.loadJobOptions()
    }

    await expect(load('cloud-b', 'cloud-a')).resolves.toMatchObject({ cloudProfileId: 'cloud-b' })
    await expect(load('gone', 'cloud-b')).resolves.toMatchObject({ cloudProfileId: 'cloud-b' })
    await expect(load('gone', 'gone')).resolves.toMatchObject({ cloudProfileId: 'cloud-a' })
    await expect(load('gone', 'gone', [])).resolves.toMatchObject({ cloudProfileId: '' })
  })

  it('captures model and cloud profile errors independently', async () => {
    const modelFailureHarness = createHarness()
    modelFailureHarness.invoke.mockImplementation(async (command: string) => {
      if (command === 'list_downloaded_models') throw new Error('models unavailable')
      return command === 'get_file_transcription_state' ? null : undefined
    })
    const modelFailureService = new FileTranscriptionService(modelFailureHarness.bridge, modelFailureHarness.admission)

    await expect(modelFailureService.loadJobOptions()).resolves.toMatchObject({
      models: [],
      modelsError: 'models unavailable',
      modelId: '',
      cloudProfilesError: '',
      cloudProfileId: 'cloud-a',
    })

    profileStoreMocks.loadAsrProfiles.mockRejectedValue(new Error('profiles unavailable'))
    const profileFailureHarness = createHarness()
    profileFailureHarness.invoke.mockImplementation(async (command: string) => {
      if (command === 'list_downloaded_models') return [{ id: 'installed', name: 'Installed', complete: true }]
      return command === 'get_file_transcription_state' ? null : undefined
    })
    const profileFailureService = new FileTranscriptionService(
      profileFailureHarness.bridge,
      profileFailureHarness.admission,
    )

    await expect(profileFailureService.loadJobOptions()).resolves.toMatchObject({
      models: [{ id: 'installed', name: 'Installed' }],
      modelsError: '',
      modelId: 'installed',
      cloudProfiles: [],
      cloudProfilesError: 'profiles unavailable',
      cloudProfileId: '',
    })
  })

  it('reports a cloud window-options IPC failure through cloudProfilesError', async () => {
    const harness = createHarness()
    harness.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_file_transcription_cloud_window_options') throw new Error('window options unavailable')
      if (command === 'list_downloaded_models') return []
      return command === 'get_file_transcription_state' ? null : undefined
    })
    const service = new FileTranscriptionService(harness.bridge, harness.admission)

    await expect(service.loadJobOptions()).resolves.toMatchObject({
      cloudProfiles: [],
      cloudProfilesError: 'window options unavailable',
      cloudProfileId: '',
    })
  })

  it('remembers only the provided file transcription keys', async () => {
    const harness = createHarness()
    const service = new FileTranscriptionService(harness.bridge, harness.admission)

    await service.rememberJobSelection({ modelId: 'model-a', language: 'auto', cloudWindowSeconds: 180 })

    expect(storeMocks.setSetting).toHaveBeenCalledTimes(3)
    expect(storeMocks.setSetting).toHaveBeenCalledWith('fileTranscription.modelId', 'model-a')
    expect(storeMocks.setSetting).toHaveBeenCalledWith('fileTranscription.language', 'auto')
    expect(storeMocks.setSetting).toHaveBeenCalledWith('fileTranscription.cloudWindowSeconds', 180)
    expect(storeMocks.setSetting).not.toHaveBeenCalledWith('fileTranscription.engine', expect.anything())
    expect(storeMocks.setSetting).not.toHaveBeenCalledWith('localAsr.modelId', expect.anything())
  })

  it('starts a local run with the selected model and language while keeping the global accelerator', async () => {
    const harness = createHarness()
    harness.invoke.mockImplementation(async (command: string) => {
      if (command === 'start_file_transcription') return snapshot({ resourcesReleased: true })
      if (command === 'list_downloaded_models') return [{ id: 'selected-model', name: 'Selected', complete: true }]
      return command === 'get_file_transcription_state' ? null : undefined
    })
    storeMocks.getSetting.mockImplementation(async (key: string, fallback: unknown) => {
      if (key === 'localAsr.accelerator') return 'gpu'
      return fallback
    })
    const service = new FileTranscriptionService(harness.bridge, harness.admission)

    await service.startWithCurrentSettings({
      filePath: 'C:/recording.mp4',
      outputDirectory: 'C:/output',
      ffmpegDirectory: null,
      audioStreamIndex: null,
      engine: 'local',
      modelId: ' selected-model ',
      language: 'en',
    })

    expect(harness.invoke).toHaveBeenCalledWith('start_file_transcription', {
      request: {
        filePath: 'C:/recording.mp4',
        outputDirectory: 'C:/output',
        ffmpegDirectory: null,
        audioStreamIndex: null,
        engine: 'local',
        cloud: null,
        modelId: 'selected-model',
        language: 'en',
        accelerator: 'gpu',
      },
    })
    expect(storeMocks.setSetting).not.toHaveBeenCalledWith('localAsr.modelId', expect.anything())
    expect(storeMocks.setSetting).not.toHaveBeenCalledWith('speechInput.language', expect.anything())
  })

  it('refuses to start a local run when the downloaded model list cannot be read', async () => {
    const harness = createHarness()
    harness.invoke.mockImplementation(async (command: string) => {
      if (command === 'list_downloaded_models') throw new Error('ipc boom')
      return command === 'get_file_transcription_state' ? null : undefined
    })
    const service = new FileTranscriptionService(harness.bridge, harness.admission)

    await expect(
      service.startWithCurrentSettings({
        filePath: 'C:/recording.mp4',
        outputDirectory: 'C:/output',
        ffmpegDirectory: null,
        audioStreamIndex: null,
        modelId: 'selected-model',
      }),
    ).rejects.toThrow('ipc boom')

    expect(harness.invoke).not.toHaveBeenCalledWith('start_file_transcription', expect.anything())
  })

  it('rejects a local start without a model and never invokes the worker', async () => {
    const harness = createHarness()
    const service = new FileTranscriptionService(harness.bridge, harness.admission)

    await expect(
      service.startWithCurrentSettings({
        filePath: 'C:/recording.mp4',
        outputDirectory: 'C:/output',
        ffmpegDirectory: null,
        audioStreamIndex: null,
      }),
    ).rejects.toThrow('A local ASR model must be selected')

    expect(harness.invoke).not.toHaveBeenCalledWith('start_file_transcription', expect.anything())
  })

  it('builds a cloud request from a fixed profile snapshot and does not reserve local admission', async () => {
    const harness = createHarness()
    harness.invoke.mockImplementation(async (command: string) => {
      if (command === 'start_file_transcription')
        return snapshot({ engine: 'cloud', cloudLabel: 'Groq Whisper', resourcesReleased: true })
      if (command === 'list_downloaded_models') throw new Error('local model list unavailable')
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
      language: 'en',
      cloudWindowSeconds: 180,
    })

    const startCall = harness.invoke.mock.calls.find(([command]) => command === 'start_file_transcription')
    const request = (startCall?.[1] as { request: Record<string, unknown> }).request
    expect(request).toEqual({
      filePath: 'C:/recording.mp4',
      outputDirectory: 'C:/output',
      ffmpegDirectory: null,
      audioStreamIndex: 2,
      engine: 'cloud',
      language: 'en',
      cloud: {
        label: 'Groq Whisper',
        config: {
          provider: 'groq_whisper',
          api_key: 'cloud-key',
          app_id: '',
          extra: { model: 'whisper-large-v3', language: 'en' },
        },
        windowSeconds: 180,
      },
    })
    expect(request).not.toHaveProperty('modelId')
    expect(request).toHaveProperty('language', 'en')
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
      if (command === 'list_available_models' || command === 'list_downloaded_models') return []
      return command === 'get_file_transcription_state' ? null : undefined
    })
    const service = new FileTranscriptionService(harness.bridge, harness.admission)

    await expect(
      service.startWithCurrentSettings({
        filePath: 'C:/recording.mp4',
        outputDirectory: 'C:/output',
        ffmpegDirectory: null,
        audioStreamIndex: null,
        modelId: DEFAULT_LOCAL_MODEL_ID,
      }),
    ).rejects.toThrow('native start failed')

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
      if (command === 'list_available_models' || command === 'list_downloaded_models') return []
      return command === 'get_file_transcription_state' ? null : undefined
    })
    const service = new FileTranscriptionService(harness.bridge, harness.admission)

    await service.startWithCurrentSettings({
      filePath: 'C:/recording.mp4',
      outputDirectory: 'C:/output',
      ffmpegDirectory: null,
      audioStreamIndex: null,
      modelId: DEFAULT_LOCAL_MODEL_ID,
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
    const startCalled = new Promise<void>((resolve) => {
      startInvoked = resolve
    })
    harness.invoke.mockImplementation((command: string) => {
      if (command === 'start_file_transcription') {
        startInvoked()
        return new Promise((_resolve, reject) => {
          rejectStart = reject
        })
      }
      if (command === 'list_available_models' || command === 'list_downloaded_models') return Promise.resolve([])
      return Promise.resolve(command === 'get_file_transcription_state' ? null : undefined)
    })
    const service = new FileTranscriptionService(harness.bridge, harness.admission)
    await service.init()

    const startPromise = service.startWithCurrentSettings({
      filePath: 'C:/recording.mp4',
      outputDirectory: 'C:/output',
      ffmpegDirectory: null,
      audioStreamIndex: null,
      modelId: DEFAULT_LOCAL_MODEL_ID,
    })
    await startCalled
    stateHandler?.({ payload: snapshot({ sequence: 1 }) })
    stateHandler?.({
      payload: snapshot({
        sequence: 2,
        phase: 'failed',
        resourcesReleased: true,
        error: 'Failed to start file transcription worker',
      }),
    })
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
    const startCalled = new Promise<void>((resolve) => {
      startInvoked = resolve
    })
    harness.invoke.mockImplementation((command: string) => {
      if (command === 'start_file_transcription') {
        startInvoked()
        return new Promise((_resolve, reject) => {
          rejectStart = reject
        })
      }
      if (command === 'list_available_models' || command === 'list_downloaded_models') return Promise.resolve([])
      return Promise.resolve(command === 'get_file_transcription_state' ? null : undefined)
    })
    const service = new FileTranscriptionService(harness.bridge, harness.admission)
    await service.init()

    const startPromise = service.startWithCurrentSettings({
      filePath: 'C:/recording.mp4',
      outputDirectory: 'C:/output',
      ffmpegDirectory: null,
      audioStreamIndex: null,
      modelId: DEFAULT_LOCAL_MODEL_ID,
    })
    await startCalled
    stateHandler?.({ payload: snapshot({ sequence: 1 }) })
    rejectStart(new Error('Failed to start file transcription worker'))
    await expect(startPromise).rejects.toThrow('Failed to start file transcription worker')
    expect(harness.admission.releaseFileTranscription).not.toHaveBeenCalled()

    stateHandler?.({
      payload: snapshot({
        sequence: 2,
        phase: 'failed',
        resourcesReleased: true,
        error: 'Failed to start file transcription worker',
      }),
    })
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
    const startCalled = new Promise<void>((resolve) => {
      startInvoked = resolve
    })
    harness.invoke.mockImplementation((command: string) => {
      if (command === 'start_file_transcription') {
        startInvoked()
        return new Promise((_resolve, reject) => {
          rejectStart = reject
        })
      }
      if (command === 'list_available_models' || command === 'list_downloaded_models') return Promise.resolve([])
      return Promise.resolve(command === 'get_file_transcription_state' ? null : undefined)
    })
    const service = new FileTranscriptionService(harness.bridge, harness.admission)
    await service.init()

    const startPromise = service.startWithCurrentSettings({
      filePath: 'C:/recording.mp4',
      outputDirectory: 'C:/output',
      ffmpegDirectory: null,
      audioStreamIndex: null,
      modelId: DEFAULT_LOCAL_MODEL_ID,
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

    stateHandler?.({
      payload: snapshot({
        engine: 'cloud',
        cloudLabel: 'Groq Whisper',
        sequence: 2,
        phase: 'completed',
        resourcesReleased: true,
      }),
    })

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
    const starts = [snapshot({ jobId: 'job-1', sequence: 1 }), snapshot({ jobId: 'job-2', sequence: 3 })]
    harness.invoke.mockImplementation(async (command: string) => {
      if (command === 'start_file_transcription') return starts.shift()
      if (command === 'list_available_models' || command === 'list_downloaded_models') return []
      return command === 'get_file_transcription_state' ? null : undefined
    })
    const service = new FileTranscriptionService(harness.bridge, harness.admission)

    await service.startWithCurrentSettings({
      filePath: 'C:/one.mp4',
      outputDirectory: 'C:/output',
      ffmpegDirectory: null,
      audioStreamIndex: null,
      modelId: DEFAULT_LOCAL_MODEL_ID,
    })
    stateHandler?.({ payload: snapshot({ jobId: 'job-1', sequence: 1, resourcesReleased: true, phase: 'failed' }) })
    expect(harness.admission.releaseFileTranscription).not.toHaveBeenCalled()
    stateHandler?.({ payload: snapshot({ jobId: 'job-1', sequence: 2, resourcesReleased: true, phase: 'failed' }) })
    await service.startWithCurrentSettings({
      filePath: 'C:/two.mp4',
      outputDirectory: 'C:/output',
      ffmpegDirectory: null,
      audioStreamIndex: null,
      modelId: DEFAULT_LOCAL_MODEL_ID,
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

  it('keeps initialization readiness untouched when a state event is rejected', async () => {
    const harness = createHarness()
    let stateHandler: ((event: { payload: FileTranscriptionSnapshot }) => void) | undefined
    harness.listen.mockImplementation(async (_event, handler) => {
      stateHandler = handler as (event: { payload: FileTranscriptionSnapshot }) => void
      return () => undefined
    })
    harness.invoke.mockImplementation(async (command: string) =>
      command === 'get_file_transcription_state' ? null : undefined,
    )
    const service = new FileTranscriptionService(harness.bridge, harness.admission)

    await service.init()
    harness.admission.setFileTranscriptionAdmissionReady.mockClear()
    harness.admission.reserveFileTranscription.mockImplementationOnce(() => {
      throw new Error('The local engine is busy')
    })

    stateHandler?.({ payload: snapshot({ sequence: 5 }) })

    expect(service.getInitializationError()).toBe('The local engine is busy')
    expect(service.getSnapshot()).toBeNull()
    expect(harness.admission.setFileTranscriptionAdmissionReady).not.toHaveBeenCalled()

    // The rejected snapshot was not consumed, so a retry accepts it unchanged.
    harness.invoke.mockImplementation(async (command: string) =>
      command === 'get_file_transcription_state' ? snapshot({ sequence: 5 }) : undefined,
    )
    await service.init()

    expect(service.getInitializationError()).toBeNull()
    expect(service.getSnapshot()?.sequence).toBe(5)
    expect(harness.admission.reserveFileTranscription).toHaveBeenCalledTimes(2)
  })

  it('keeps readiness closed during a pending init when an event is rejected', async () => {
    const harness = createHarness()
    let stateHandler: ((event: { payload: FileTranscriptionSnapshot }) => void) | undefined
    harness.listen.mockImplementation(async (_event, handler) => {
      stateHandler = handler as (event: { payload: FileTranscriptionSnapshot }) => void
      return () => undefined
    })
    let resolveState: (value: FileTranscriptionSnapshot | null) => void = () => undefined
    const stateQuery = new Promise<FileTranscriptionSnapshot | null>((resolve) => {
      resolveState = resolve
    })
    harness.invoke.mockImplementation(async (command: string) =>
      command === 'get_file_transcription_state' ? stateQuery : undefined,
    )
    const service = new FileTranscriptionService(harness.bridge, harness.admission)
    harness.admission.reserveFileTranscription.mockImplementationOnce(() => {
      throw new Error('busy during init')
    })

    const initPromise = service.init()
    await vi.waitFor(() => expect(stateHandler).toBeDefined())
    stateHandler?.({ payload: snapshot({ sequence: 5 }) })

    expect(service.getInitializationError()).toBe('busy during init')
    expect(harness.admission.setFileTranscriptionAdmissionReady).toHaveBeenCalledTimes(1)
    expect(harness.admission.setFileTranscriptionAdmissionReady).toHaveBeenCalledWith(false)

    resolveState(null)
    await initPromise

    expect(service.getInitializationError()).toBeNull()
    expect(harness.admission.setFileTranscriptionAdmissionReady).toHaveBeenNthCalledWith(2, true)
    expect(harness.admission.setFileTranscriptionAdmissionReady).toHaveBeenCalledTimes(2)
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

  it('normalizes thrown values to a message string', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
    expect(errorMessage('plain failure')).toBe('plain failure')
  })

  it('normalizes classified inspection failures and preserves unclassified values', () => {
    const ffmpegFailure = normalizeInspectionFailure({ kind: 'ffmpeg-tools', message: 'x' }) as Error & {
      inspectionKind?: string
    }
    const mediaFailure = normalizeInspectionFailure({ kind: 'media', message: 'y' }) as Error & {
      inspectionKind?: string
    }
    const plainError = new Error('z')

    expect(ffmpegFailure).toBeInstanceOf(Error)
    expect(ffmpegFailure.message).toBe('x')
    expect(ffmpegFailure.inspectionKind).toBe('ffmpeg-tools')
    expect(mediaFailure.message).toBe('y')
    expect(mediaFailure.inspectionKind).toBe('media')
    expect(normalizeInspectionFailure(plainError)).toBe(plainError)
    expect(
      (normalizeInspectionFailure(plainError) as Error & { inspectionKind?: string }).inspectionKind,
    ).toBeUndefined()
    expect(normalizeInspectionFailure('plain failure')).toBe('plain failure')
  })

  it('sends clipboard text through the injected bridge', async () => {
    const harness = createHarness()
    const service = new FileTranscriptionService(harness.bridge, harness.admission)

    await service.copyText('hello')

    expect(harness.copyText).toHaveBeenCalledWith('hello')
  })

  it('drops stale snapshot sequences and accepts the next newer one', async () => {
    const harness = createHarness()
    let stateHandler: ((event: { payload: FileTranscriptionSnapshot }) => void) | undefined
    harness.listen.mockImplementation(async (_event, handler) => {
      stateHandler = handler as (event: { payload: FileTranscriptionSnapshot }) => void
      return () => undefined
    })
    harness.invoke.mockImplementation(async (command: string) =>
      command === 'get_file_transcription_state' ? snapshot({ sequence: 5 }) : undefined,
    )
    const service = new FileTranscriptionService(harness.bridge, harness.admission)
    const notifications = vi.fn()
    service.subscribe(notifications)

    await service.init()
    expect(service.getSnapshot()?.sequence).toBe(5)
    notifications.mockClear()

    // Different payloads on the same job: the snapshot must remain untouched.
    stateHandler?.({ payload: snapshot({ sequence: 3, text: 'older text' }) })
    stateHandler?.({ payload: snapshot({ sequence: 5, text: 'same sequence text' }) })

    expect(service.getSnapshot()?.sequence).toBe(5)
    expect(service.getSnapshot()?.text).toBe('Saved text')
    expect(notifications).not.toHaveBeenCalled()

    stateHandler?.({ payload: snapshot({ sequence: 6, text: 'newer text' }) })

    expect(service.getSnapshot()?.sequence).toBe(6)
    expect(service.getSnapshot()?.text).toBe('newer text')
    expect(notifications).toHaveBeenCalledTimes(1)
  })
})
