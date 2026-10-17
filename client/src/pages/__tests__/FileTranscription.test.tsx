// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, act, within, cleanup } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import FileTranscription from '../FileTranscription'
import { setLocale } from '@/i18n'
import { emptyAsrProfile, type AsrProfile } from '@/features/settings/asrProviderCatalog'
import { fileTranscriptionService, type FileTranscriptionJobOptions, type FileTranscriptionSnapshot } from '@/services/fileTranscription'
import { releaseFileTranscription, reserveFileTranscription } from '@/services/recorder'

const native = vi.hoisted(() => {
  const settings = new Map<string, unknown>()
  const storeWrites: Array<{ key: string; value: unknown }> = []
  const defaultInvoke = async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    if (command === 'get_file_transcription_state') return null
    if (command === 'store_get') {
      if (settings.has(args?.key as string)) return settings.get(args?.key as string)
      if (args?.key === 'speechInput.language') return 'en'
      if (args?.key === 'localAsr.modelId') return 'sensevoice-small-gguf'
      if (args?.key === 'localAsr.accelerator') return 'auto'
      return null
    }
    if (command === 'store_set') {
      const key = args?.key as string
      const value = args?.value
      settings.set(key, value)
      storeWrites.push({ key, value })
      return undefined
    }
    if (command === 'list_downloaded_models') return [{ id: 'sensevoice-small-gguf', name: 'SenseVoice Small', complete: true }]
    if (command === 'detect_ffmpeg_directory') return detectedFfmpegDirectory
    if (command === 'inspect_transcription_file') return {
      durationMs: 12_000,
      audioTracks: [
        { index: 3, label: 'First track', isDefault: false },
        { index: 9, label: 'Default track', isDefault: true },
      ],
    }
    return undefined
  }
  return {
    defaultInvoke,
    invoke: vi.fn(defaultInvoke),
    listen: vi.fn(async (_event: string, _handler: (event: { payload: unknown }) => void): Promise<() => void> => () => undefined),
    settings,
    storeWrites,
  }
})

const dialog = vi.hoisted(() => ({ open: vi.fn() }))
const cloudProfiles = vi.hoisted(() => ({ loadAsrProfiles: vi.fn() }))
let detectedFfmpegDirectory: string | null = null
let stateListener: ((event: { payload: FileTranscriptionSnapshot }) => void) | null = null
let snapshotSequenceBase = 0

function nativeInvoke<T>(command: string, args?: Record<string, unknown>) {
  return native.invoke(command, args) as Promise<T>
}

function nativeListen<T>(event: string, handler: (payload: { payload: T }) => void) {
  stateListener = handler as (event: { payload: FileTranscriptionSnapshot }) => void
  return native.listen(event, handler as (payload: { payload: unknown }) => void)
}

vi.mock('@/services/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/bridge')>()
  return {
    ...actual,
    invoke: nativeInvoke,
    listen: nativeListen,
  }
})
vi.mock('@tauri-apps/api/core', () => ({ invoke: nativeInvoke }))
vi.mock('@tauri-apps/plugin-dialog', () => dialog)
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }))
vi.mock('@/features/settings/asrProfileStore', () => cloudProfiles)

function renderPage() {
  return render(<MemoryRouter><FileTranscription /></MemoryRouter>)
}

function fileSnapshot(overrides: Partial<FileTranscriptionSnapshot> = {}): FileTranscriptionSnapshot {
  const { sequence = 1, ...rest } = overrides
  return {
    jobId: 'job-1',
    sequence: snapshotSequenceBase + sequence,
    phase: 'failed',
    durationMs: 12_000,
    processedMs: 12_000,
    savedMs: 12_000,
    text: 'Draft text',
    draftPath: 'C:/output/job-1.partial.txt',
    txtPath: null,
    markdownPath: null,
    error: 'Native transcription failed',
    warning: null,
    retryableExport: false,
    resourcesReleased: true,
    engine: 'local',
    cloudLabel: null,
    ...rest,
  }
}

function cloudProfile(overrides: Partial<AsrProfile> = {}): AsrProfile {
  return {
    ...emptyAsrProfile('deepgram'),
    id: 'cloud-profile-1',
    apiKey: 'test-key',
    ...overrides,
  }
}

describe('file transcription page', () => {
  afterEach(() => {
    cleanup()
    fileTranscriptionService.dispose()
    releaseFileTranscription()
    setLocale('en')
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    native.invoke.mockClear()
    native.invoke.mockImplementation(native.defaultInvoke)
    native.listen.mockClear()
    dialog.open.mockReset()
    detectedFfmpegDirectory = null
    snapshotSequenceBase += 100
    cloudProfiles.loadAsrProfiles.mockReset()
    cloudProfiles.loadAsrProfiles.mockResolvedValue({ profiles: [], activeId: '' })
    native.settings.clear()
    native.storeWrites.length = 0
  })

  it('shows the file picker workflow with installed model and language selects', async () => {
    renderPage()

    expect(screen.getByRole('heading', { name: /Transcribe a file/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Choose audio or video file' })).toBeTruthy()
    await waitFor(() => expect(screen.getByText('SenseVoice Small')).toBeTruthy())
    expect(screen.getByText('English')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Model' })).toBeTruthy()
  })

  it('lists only installed models, starts with the chosen model, and remembers it on the page', async () => {
    const downloadedModels = [
      { id: 'sensevoice-small-gguf', name: 'SenseVoice Small', complete: true },
      { id: 'custom-installed', name: 'Custom installed', complete: true },
      { id: 'partial-model', name: 'Partial model', complete: false },
    ]
    dialog.open.mockResolvedValueOnce('C:/recording.mp4').mockResolvedValueOnce('C:/output')
    native.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'list_downloaded_models') return downloadedModels
      if (command === 'start_file_transcription') return fileSnapshot({ phase: 'completed', error: null })
      return native.defaultInvoke(command, args)
    })
    const startSpy = vi.spyOn(fileTranscriptionService, 'startWithCurrentSettings')
    renderPage()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Model' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Model' }))
    expect(screen.getByRole('button', { name: 'Custom installed' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Partial model' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Custom installed' }))

    await waitFor(() => expect(native.storeWrites).toContainEqual({
      key: 'fileTranscription.modelId',
      value: 'custom-installed',
    }))
    expect(native.storeWrites).not.toContainEqual(expect.objectContaining({ key: 'localAsr.modelId' }))

    fireEvent.click(screen.getByRole('button', { name: 'Choose audio or video file' }))
    await waitFor(() => expect(screen.getByText('C:/recording.mp4')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Choose output folder' }))
    await waitFor(() => expect(screen.getByText('C:/output')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Start transcription' }))

    await waitFor(() => expect(startSpy).toHaveBeenCalledWith(expect.objectContaining({
      engine: 'local',
      modelId: 'custom-installed',
    })))
  })

  it('applies remembered engine, model, language, and cloud profile values on open', async () => {
    native.settings.set('fileTranscription.engine', 'cloud')
    native.settings.set('fileTranscription.modelId', 'custom-installed')
    native.settings.set('fileTranscription.language', 'auto')
    native.settings.set('fileTranscription.cloudProfileId', 'cloud-profile-2')
    native.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'list_downloaded_models') {
        return [{ id: 'custom-installed', name: 'Custom installed', complete: true }]
      }
      return native.defaultInvoke(command, args)
    })
    cloudProfiles.loadAsrProfiles.mockResolvedValue({
      profiles: [
        cloudProfile(),
        cloudProfile({ id: 'cloud-profile-2', provider: 'openai_transcribe', model: 'whisper-1' }),
      ],
      activeId: 'cloud-profile-1',
    })
    renderPage()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Cloud' }).getAttribute('aria-pressed')).toBe('true'))
    expect(screen.getByRole('button', { name: 'Language' }).textContent).toContain('Auto')
    expect(screen.getByText('whisper-1')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Local' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Model' }).textContent).toContain('Custom installed'))
  })

  it('disables engine and language controls until the first options load resolves', async () => {
    let resolveOptions: (value: FileTranscriptionJobOptions) => void = () => undefined
    const pendingOptions = new Promise<FileTranscriptionJobOptions>((resolve) => { resolveOptions = resolve })
    vi.spyOn(fileTranscriptionService, 'loadJobOptions').mockReturnValue(pendingOptions)
    renderPage()

    const localButton = screen.getByRole('button', { name: 'Local' })
    const cloudButton = screen.getByRole('button', { name: 'Cloud' })
    const languageButton = screen.getByRole('button', { name: 'Language' })
    expect((localButton as HTMLButtonElement).disabled).toBe(true)
    expect((cloudButton as HTMLButtonElement).disabled).toBe(true)
    expect((languageButton as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(cloudButton)
    fireEvent.click(languageButton)
    await act(async () => {
      resolveOptions({
        engine: 'cloud',
        models: [{ id: 'local-model', name: 'Local model' }],
        modelsError: '',
        modelId: 'local-model',
        language: 'uk',
        accelerator: 'auto',
        cloudProfiles: [],
        cloudProfilesError: '',
        cloudProfileId: '',
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await waitFor(() => expect(cloudButton.getAttribute('aria-pressed')).toBe('true'))
    expect(languageButton.textContent).toContain('Ukrainian')
  })

  it('marks the page title with the shared alpha badge', () => {
    renderPage()

    const heading = screen.getByRole('heading', { level: 1 })
    expect(heading.querySelector('svg')).toBeTruthy()
    expect(heading.textContent).toContain('Alpha')
  })

  it('uses the bundled FFmpeg by default without offering a PATH mode', async () => {
    renderPage()

    await waitFor(() => expect(screen.getByText("Using SayIt's built-in FFmpeg and FFprobe")).toBeTruthy())
    expect(screen.getByText(/SayIt includes built-in FFmpeg and FFprobe/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /path/i })).toBeNull()
  })

  it('shows bundled resolver errors in the page error alert', async () => {
    const message = 'The bundled FFmpeg and FFprobe are missing or damaged. Please reinstall SayIt.'
    dialog.open.mockResolvedValue('C:/recording.mp4')
    native.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'inspect_transcription_file') throw new Error(message)
      return native.defaultInvoke(command, args)
    })
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Choose audio or video file' }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(`Could not inspect this file: ${message}`))
  })

  it('shows selected FFmpeg folder resolver errors in the page error alert', async () => {
    const message = 'The selected FFmpeg folder does not contain both ffmpeg.exe and ffprobe.exe: C:/broken/ffmpeg'
    dialog.open.mockResolvedValueOnce('C:/broken/ffmpeg').mockResolvedValueOnce('C:/recording.mp4')
    native.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'inspect_transcription_file') throw new Error(message)
      return native.defaultInvoke(command, args)
    })
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }))
    await waitFor(() => expect(screen.getByText('C:/broken/ffmpeg')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Choose audio or video file' }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(`Could not inspect this file: ${message}`))
  })

  it('renders the cloud profile selector with provider, model, and label details', async () => {
    cloudProfiles.loadAsrProfiles.mockResolvedValue({
      profiles: [cloudProfile()],
      activeId: 'cloud-profile-1',
    })
    renderPage()

    await waitFor(() => expect(screen.getByText('SenseVoice Small')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Cloud' }))

    expect(screen.getByRole('button', { name: 'Cloud profile' })).toBeTruthy()
    expect(screen.getByText('Deepgram')).toBeTruthy()
    expect(screen.getByText('nova-3')).toBeTruthy()
  })

  it('selects the active cloud profile instead of the first profile', async () => {
    cloudProfiles.loadAsrProfiles.mockResolvedValue({
      profiles: [
        cloudProfile(),
        cloudProfile({ id: 'cloud-profile-2', provider: 'openai_transcribe', model: 'whisper-1' }),
      ],
      activeId: 'cloud-profile-2',
    })
    renderPage()

    await waitFor(() => expect(screen.getByText('SenseVoice Small')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Cloud' }))

    expect(screen.getByText('OpenAI transcription')).toBeTruthy()
    expect(screen.getByText('whisper-1')).toBeTruthy()
    expect(screen.queryByText('openai_transcribe')).toBeNull()
  })

  it('allows cloud transcription without an installed local model and sends the selected cloud profile', async () => {
    cloudProfiles.loadAsrProfiles.mockResolvedValue({
      profiles: [
        cloudProfile(),
        cloudProfile({ id: 'cloud-profile-2', provider: 'openai_transcribe', model: 'whisper-1' }),
      ],
      activeId: 'cloud-profile-1',
    })
    dialog.open.mockResolvedValueOnce('C:/recording.mp4')
      .mockResolvedValueOnce('C:/output')
    native.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'list_downloaded_models') return []
      if (command === 'start_file_transcription') {
        return fileSnapshot({
          phase: 'completed',
          error: null,
          resourcesReleased: true,
          engine: 'cloud',
          cloudLabel: 'Deepgram',
        })
      }
      return native.defaultInvoke(command, args)
    })
    const startSpy = vi.spyOn(fileTranscriptionService, 'startWithCurrentSettings')
    renderPage()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Cloud' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Cloud' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cloud profile' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Cloud profile' }))
    fireEvent.click(screen.getByRole('button', { name: 'OpenAI transcription · whisper-1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Language' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ukrainian' }))
    await waitFor(() => expect(native.storeWrites).toContainEqual({
      key: 'fileTranscription.language',
      value: 'uk',
    }))
    expect(native.storeWrites).toContainEqual({ key: 'fileTranscription.engine', value: 'cloud' })
    expect(native.storeWrites).toContainEqual({ key: 'fileTranscription.cloudProfileId', value: 'cloud-profile-2' })
    expect(native.storeWrites).not.toContainEqual(expect.objectContaining({ key: 'speechInput.language' }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose audio or video file' }))
    await waitFor(() => expect(screen.getByText('C:/recording.mp4')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Choose output folder' }))
    await waitFor(() => expect(screen.getByText('C:/output')).toBeTruthy())

    const startButton = screen.getByRole('button', { name: 'Start transcription' })
    expect((startButton as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(startButton)

    await waitFor(() => expect(startSpy).toHaveBeenCalledWith(expect.objectContaining({
      engine: 'cloud',
      cloudProfileId: 'cloud-profile-2',
      language: 'uk',
    })))
    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith('start_file_transcription', {
      request: expect.objectContaining({
        engine: 'cloud',
        cloud: {
          label: 'OpenAI transcription',
          config: expect.objectContaining({
            provider: 'openai_transcribe',
            extra: expect.objectContaining({ language: 'uk' }),
          }),
        },
      }),
    }))
  })

  it('shows a settings link instead of a selector when no cloud profiles exist', async () => {
    renderPage()

    await waitFor(() => expect(screen.getByText('SenseVoice Small')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Cloud' }))

    expect(screen.getByText('No cloud profiles are configured.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open Cloud API settings' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Cloud profile' })).toBeNull()
  })

  it('retries local settings after a settings error', async () => {
    native.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'list_downloaded_models') throw new Error('engine offline')
      return native.defaultInvoke(command, args)
    })

    renderPage()

    await waitFor(() => expect(screen.getByText('Could not read local engine settings: engine offline')).toBeTruthy())
    expect(screen.queryByText('SenseVoice Small')).toBeNull()

    native.invoke.mockImplementation(native.defaultInvoke)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(screen.getByText('SenseVoice Small')).toBeTruthy())
    expect(screen.queryByText('Could not read local engine settings: engine offline')).toBeNull()
  })

  it('drops a stale retry response when a newer locale load has completed', async () => {
    let modelCall = 0
    let resolveRetryModels: (models: Array<{ id: string; name: string; complete: boolean }>) => void = () => undefined
    const retryModels = new Promise<Array<{ id: string; name: string; complete: boolean }>>((resolve) => {
      resolveRetryModels = resolve
    })
    native.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'list_downloaded_models') {
        modelCall += 1
        if (modelCall === 1) throw new Error('initial engine offline')
        if (modelCall === 2) return retryModels
        return [{ id: 'newer-model', name: 'Newer model', complete: true }]
      }
      return native.defaultInvoke(command, args)
    })
    renderPage()

    await waitFor(() => expect(screen.getByText('Could not read local engine settings: initial engine offline')).toBeTruthy())
    const retryButton = screen.getByRole('button', { name: 'Retry' })
    fireEvent.click(retryButton)
    await waitFor(() => expect(modelCall).toBe(2))
    expect((retryButton as HTMLButtonElement).disabled).toBe(true)

    act(() => { setLocale('uk') })
    await waitFor(() => expect(modelCall).toBe(3))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Модель' }).textContent).toContain('Newer model'))

    resolveRetryModels([{ id: 'stale-model', name: 'Stale model', complete: true }])
    await act(async () => {})
    expect(screen.getByRole('button', { name: 'Модель' }).textContent).toContain('Newer model')
    expect(screen.queryByText('Stale model')).toBeNull()
  })

  it('shows the no-installed-model notice and keeps Start disabled', async () => {
    native.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'list_downloaded_models') return []
      return native.defaultInvoke(command, args)
    })

    renderPage()

    await waitFor(() => expect(screen.getByText('No local models are installed. Download one in Voice Engine first.')).toBeTruthy())
    expect(screen.getByRole('link', { name: 'Open Voice Engine settings' })).toBeTruthy()
    const startButton = screen.getByRole('button', { name: 'Start transcription' })
    expect((startButton as HTMLButtonElement).disabled).toBe(true)
  })

  it('preselects the default physical audio track instead of the first track', async () => {
    dialog.open.mockResolvedValue('C:/recording.mp4')
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Choose audio or video file' }))

    await waitFor(() => {
      const trackTrigger = screen.getByRole('button', { name: 'Audio track' })
      expect(trackTrigger.textContent).toContain('Default track')
    })
  })

  it('shows retry export only for a released retryable export failure', async () => {
    renderPage()
    await waitFor(() => expect(stateListener).not.toBeNull())

    act(() => {
      stateListener?.({ payload: fileSnapshot({ sequence: 1, error: 'Native transcription failed', retryableExport: false }) })
    })
    expect(screen.getByText('Native transcription failed')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry export' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()

    act(() => {
      stateListener?.({ payload: fileSnapshot({
        jobId: 'job-2',
        sequence: 2,
        error: 'Native transcription failed',
        retryableExport: true,
        resourcesReleased: false,
      }) })
    })
    expect(screen.queryByRole('button', { name: 'Retry export' })).toBeNull()

    act(() => {
      stateListener?.({ payload: fileSnapshot({
        jobId: 'job-2',
        sequence: 3,
        error: 'Native transcription failed',
        retryableExport: true,
      }) })
    })
    expect(screen.getByRole('button', { name: 'Retry export' })).toBeTruthy()

    act(() => {
      stateListener?.({ payload: fileSnapshot({
        jobId: 'job-2',
        sequence: 4,
        error: 'Final export failed: disk full',
        retryableExport: false,
      }) })
    })
    expect(screen.queryByRole('button', { name: 'Retry export' })).toBeNull()
  })

  it('opens cancellation confirmation without cancelling immediately', async () => {
    renderPage()
    await waitFor(() => expect(stateListener).not.toBeNull())

    act(() => {
      stateListener?.({ payload: fileSnapshot({
        jobId: 'job-cancel-1',
        sequence: 10,
        phase: 'transcribing',
        resourcesReleased: false,
        error: null,
      }) })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('Stop transcription?')).toBeTruthy()
    expect(native.invoke).not.toHaveBeenCalledWith('cancel_file_transcription', expect.anything())
  })

  it('does not reopen the cancellation confirmation for the next job', async () => {
    renderPage()
    await waitFor(() => expect(stateListener).not.toBeNull())
    act(() => {
      stateListener?.({ payload: fileSnapshot({
        jobId: 'job-cancel-1',
        sequence: 12,
        phase: 'transcribing',
        resourcesReleased: false,
        error: null,
      }) })
    })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('dialog')).toBeTruthy()

    act(() => {
      stateListener?.({ payload: fileSnapshot({
        jobId: 'job-cancel-1',
        sequence: 13,
        phase: 'completed',
        resourcesReleased: true,
        error: null,
      }) })
    })
    expect(screen.queryByRole('dialog')).toBeNull()

    act(() => {
      stateListener?.({ payload: fileSnapshot({
        jobId: 'job-2',
        sequence: 14,
        phase: 'preparing',
        resourcesReleased: false,
        error: null,
      }) })
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows a failed worker start once when the terminal snapshot repeats the rejection', async () => {
    dialog.open.mockResolvedValueOnce('C:/recording.mp4').mockResolvedValueOnce('C:/output')
    const message = 'Failed to start file transcription worker: boom'
    native.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'start_file_transcription') throw new Error(message)
      return native.defaultInvoke(command, args)
    })
    renderPage()

    await waitFor(() => expect(screen.getByText('SenseVoice Small')).toBeTruthy())
    await waitFor(() => expect(stateListener).not.toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Choose audio or video file' }))
    await waitFor(() => expect(screen.getByText('C:/recording.mp4')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Choose output folder' }))
    await waitFor(() => expect(screen.getByText('C:/output')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Start transcription' }))
    await waitFor(() => expect(screen.getByText(`Could not start transcription: ${message}`)).toBeTruthy())

    act(() => {
      stateListener?.({ payload: fileSnapshot({
        phase: 'failed',
        error: message,
        resourcesReleased: true,
      }) })
    })

    expect(screen.getAllByText(message)).toHaveLength(1)
    expect(screen.queryByText(/Could not start transcription/)).toBeNull()
  })

  it('cancels exactly once only after confirmation', async () => {
    renderPage()
    await waitFor(() => expect(stateListener).not.toBeNull())
    act(() => {
      stateListener?.({ payload: fileSnapshot({
        jobId: 'job-cancel-1',
        sequence: 11,
        phase: 'transcribing',
        resourcesReleased: false,
        error: null,
      }) })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Stop transcription' }))

    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith('cancel_file_transcription', { jobId: 'job-cancel-1' }))
    expect(native.invoke.mock.calls.filter(([command]) => command === 'cancel_file_transcription')).toHaveLength(1)
  })

  it('does not cancel when the confirmation is dismissed', async () => {
    renderPage()
    await waitFor(() => expect(stateListener).not.toBeNull())
    act(() => {
      stateListener?.({ payload: fileSnapshot({
        jobId: 'job-cancel-1',
        sequence: 12,
        phase: 'transcribing',
        resourcesReleased: false,
        error: null,
      }) })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))

    expect(native.invoke).not.toHaveBeenCalledWith('cancel_file_transcription', expect.anything())
  })

  it('shows truthful preparation progress and no progress for checking or loading', async () => {
    renderPage()
    await waitFor(() => expect(stateListener).not.toBeNull())

    act(() => {
      stateListener?.({ payload: fileSnapshot({
        jobId: 'job-cancel-1',
        sequence: 20,
        phase: 'preparing',
        durationMs: 12_000,
        processedMs: 4_000,
        error: null,
        resourcesReleased: false,
      }) })
    })
    expect(screen.getByText('Processed 0:04 of 0:12')).toBeTruthy()
    const determinateProgress = screen.getByLabelText('Processed audio progress') as HTMLProgressElement
    expect(determinateProgress.value).toBe(4_000)
    expect(determinateProgress.max).toBe(12_000)

    act(() => {
      stateListener?.({ payload: fileSnapshot({
        jobId: 'job-cancel-1',
        sequence: 21,
        phase: 'preparing',
        durationMs: null,
        processedMs: 5_000,
        error: null,
        resourcesReleased: false,
      }) })
    })
    expect(screen.getByText('Processed 0:05')).toBeTruthy()
    const indeterminateProgress = screen.getByLabelText('Processed audio progress') as HTMLProgressElement
    expect(indeterminateProgress.hasAttribute('value')).toBe(false)

    act(() => {
      stateListener?.({ payload: fileSnapshot({
        jobId: 'job-cancel-1',
        sequence: 22,
        phase: 'loading',
        durationMs: null,
        processedMs: 5_000,
        error: null,
        resourcesReleased: false,
      }) })
    })
    expect(screen.queryByLabelText('Processed audio progress')).toBeNull()
    expect(screen.queryByText('Processed 0:05')).toBeNull()
  })

  it('shows saved progress while transcribing', async () => {
    renderPage()
    await waitFor(() => expect(stateListener).not.toBeNull())

    act(() => {
      stateListener?.({ payload: fileSnapshot({
        jobId: 'job-cancel-1',
        sequence: 30,
        phase: 'transcribing',
        durationMs: 60_000,
        processedMs: 25_000,
        savedMs: 20_000,
        error: null,
        resourcesReleased: false,
      }) })
    })

    expect(screen.getByText('Saved 0:20 of 1:00')).toBeTruthy()
    const progress = screen.getByLabelText('Saved audio progress') as HTMLProgressElement
    expect(progress.value).toBe(20_000)
    expect(progress.max).toBe(60_000)
  })

  it('keeps saved progress visible while finalizing', async () => {
    renderPage()
    await waitFor(() => expect(stateListener).not.toBeNull())

    act(() => {
      stateListener?.({ payload: fileSnapshot({
        jobId: 'job-cancel-1',
        sequence: 40,
        phase: 'finalizing',
        durationMs: 60_000,
        processedMs: 60_000,
        savedMs: 60_000,
        error: null,
        resourcesReleased: false,
      }) })
    })

    const progress = screen.getByLabelText('Saved audio progress') as HTMLProgressElement
    expect(progress.value).toBe(60_000)
    expect(progress.max).toBe(60_000)
  })

  it('shows indeterminate saved progress when the duration is unknown', async () => {
    renderPage()
    await waitFor(() => expect(stateListener).not.toBeNull())

    act(() => {
      stateListener?.({ payload: fileSnapshot({
        jobId: 'job-cancel-1',
        sequence: 50,
        phase: 'cancelling',
        durationMs: null,
        processedMs: 30_000,
        savedMs: 25_000,
        error: null,
        resourcesReleased: false,
      }) })
    })

    expect(screen.getByText('Saved 0:25')).toBeTruthy()
    const progress = screen.getByLabelText('Saved audio progress') as HTMLProgressElement
    expect(progress.hasAttribute('value')).toBe(false)
  })

  it('closes cancellation once the job enters finalizing', async () => {
    renderPage()
    await waitFor(() => expect(stateListener).not.toBeNull())

    act(() => {
      stateListener?.({ payload: fileSnapshot({
        jobId: 'job-cancel-1',
        sequence: 60,
        phase: 'finalizing',
        durationMs: 60_000,
        processedMs: 60_000,
        savedMs: 60_000,
        error: null,
        resourcesReleased: false,
      }) })
    })

    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()

    act(() => {
      stateListener?.({ payload: fileSnapshot({
        jobId: 'job-cancel-1',
        sequence: 61,
        phase: 'completed',
        resourcesReleased: true,
        error: null,
      }) })
    })
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
  })

  it('does not show a detected FFmpeg folder on a healthy page', async () => {
    detectedFfmpegDirectory = 'C:/tools/ffmpeg'
    renderPage()

    await waitFor(() => expect(screen.getByText('SenseVoice Small')).toBeTruthy())
    expect(screen.queryByText('C:/tools/ffmpeg')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Use this folder' })).toBeNull()
  })

  it('offers a detected FFmpeg folder after inspect fails and re-inspects when used', async () => {
    detectedFfmpegDirectory = 'C:/tools/ffmpeg'
    dialog.open.mockResolvedValue('C:/recording.mp4')
    let inspectAttempts = 0
    native.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'inspect_transcription_file') {
        inspectAttempts += 1
        if (inspectAttempts === 1) throw { kind: 'ffmpeg-tools', message: 'bundled tools unavailable' }
      }
      return native.defaultInvoke(command, args)
    })
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Choose audio or video file' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('bundled tools unavailable'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Use this folder' })).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Use this folder' }))
    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith('inspect_transcription_file', {
      filePath: 'C:/recording.mp4',
      ffmpegDirectory: 'C:/tools/ffmpeg',
    }))
    expect(screen.queryByRole('button', { name: 'Use this folder' })).toBeNull()
  })

  it('does not offer a detected FFmpeg folder for a media inspection error', async () => {
    detectedFfmpegDirectory = 'C:/tools/ffmpeg'
    dialog.open.mockResolvedValue('C:/recording.mp4')
    native.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'inspect_transcription_file') throw { kind: 'media', message: 'Invalid data found' }
      return native.defaultInvoke(command, args)
    })
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Choose audio or video file' }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Invalid data found'))
    expect(screen.queryByRole('button', { name: 'Use this folder' })).toBeNull()
  })

  it('does not show a detected FFmpeg folder for an unrelated page error', async () => {
    detectedFfmpegDirectory = 'C:/tools/ffmpeg'
    dialog.open.mockRejectedValueOnce(new Error('output picker unavailable'))
    renderPage()

    await waitFor(() => expect(screen.getByText('SenseVoice Small')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Choose output folder' }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('output picker unavailable'))
    expect(screen.queryByRole('button', { name: 'Use this folder' })).toBeNull()
  })

  it('dismisses a detected FFmpeg folder suggestion after inspect fails', async () => {
    detectedFfmpegDirectory = 'C:/tools/ffmpeg'
    dialog.open.mockResolvedValue('C:/recording.mp4')
    native.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'inspect_transcription_file') throw { kind: 'ffmpeg-tools', message: 'bundled tools unavailable' }
      return native.defaultInvoke(command, args)
    })
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Choose audio or video file' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Use this folder' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

    expect(screen.queryByRole('button', { name: 'Use this folder' })).toBeNull()
    expect(screen.queryByText('C:/tools/ffmpeg')).toBeNull()
  })

  it('keeps the detected folder hidden after the user chooses a folder manually', async () => {
    detectedFfmpegDirectory = 'C:/tools/ffmpeg'
    dialog.open.mockResolvedValue('C:/manual/ffmpeg')
    renderPage()

    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }))

    await waitFor(() => expect(screen.getByText('C:/manual/ffmpeg')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Use this folder' })).toBeNull()
  })

  it('shows no FFmpeg suggestion when detection returns no candidate', async () => {
    renderPage()

    await waitFor(() => expect(screen.getByText('SenseVoice Small')).toBeTruthy())
    expect(screen.queryByText('Use this folder')).toBeNull()
  })

  it('keeps FFmpeg detection failures quiet', async () => {
    native.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'detect_ffmpeg_directory') throw new Error('detection unavailable')
      if (command === 'store_get') {
        if (args?.key === 'speechInput.language') return 'en'
        if (args?.key === 'localAsr.modelId') return 'sensevoice-small-gguf'
        if (args?.key === 'localAsr.accelerator') return 'auto'
        return null
      }
      if (command === 'list_downloaded_models') return [{ id: 'sensevoice-small-gguf', name: 'SenseVoice Small', complete: true }]
      if (command === 'get_file_transcription_state') return null
      return undefined
    })
    renderPage()

    await waitFor(() => expect(screen.getByText('SenseVoice Small')).toBeTruthy())
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText('Use this folder')).toBeNull()
  })

  it('renders a backend warning as a separate non-error notice', async () => {
    renderPage()
    await waitFor(() => expect(stateListener).not.toBeNull())

    act(() => {
      stateListener?.({ payload: fileSnapshot({
        jobId: 'job-cancel-1',
        sequence: 70,
        phase: 'transcribing',
        error: null,
        warning: '2 fragments without recognized text were skipped (first at 0:02:20)',
        resourcesReleased: false,
      }) })
    })

    expect(screen.getByText('2 fragments without recognized text were skipped (first at 0:02:20)')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not render an absent backend warning', async () => {
    renderPage()
    await waitFor(() => expect(stateListener).not.toBeNull())

    act(() => {
      stateListener?.({ payload: fileSnapshot({
        jobId: 'job-cancel-1',
        sequence: 71,
        warning: null,
        resourcesReleased: true,
      }) })
    })

    expect(screen.queryByText('2 fragments without recognized text were skipped (first at 0:02:20)')).toBeNull()
  })

  it('keeps a backend warning visible alongside an error', async () => {
    renderPage()
    await waitFor(() => expect(stateListener).not.toBeNull())

    act(() => {
      stateListener?.({ payload: fileSnapshot({
        jobId: 'job-cancel-1',
        sequence: 72,
        error: 'Native transcription failed',
        warning: '1 fragment without recognized text was skipped',
        resourcesReleased: true,
      }) })
    })

    expect(screen.getByText('1 fragment without recognized text was skipped')).toBeTruthy()
    expect(screen.getByText('Native transcription failed')).toBeTruthy()
    expect(screen.getByRole('alert')).toBeTruthy()
  })

  it('surfaces a rejected state event with a retry instead of silently blocking local capture', async () => {
    renderPage()
    await waitFor(() => expect(stateListener).not.toBeNull())

    reserveFileTranscription()
    act(() => {
      stateListener?.({ payload: fileSnapshot({ sequence: 1, phase: 'transcribing', resourcesReleased: false, error: null }) })
    })

    expect(screen.getByText('Could not restore file transcription state: The local engine is busy. Finish the current local recording or subtitles first.')).toBeTruthy()
    expect(screen.queryByText('Draft text')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()

    releaseFileTranscription()
    native.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) =>
      command === 'get_file_transcription_state'
        ? fileSnapshot({ sequence: 1, phase: 'transcribing', resourcesReleased: false, error: null, text: '' })
        : native.defaultInvoke(command, args),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry restore' }))

    await waitFor(() => expect(screen.queryByText(/Could not restore file transcription state/)).toBeNull())
    expect(screen.getByText('Transcribing')).toBeTruthy()
  })

  it('keeps the restore failure visible when the retry is rejected again', async () => {
    renderPage()
    await waitFor(() => expect(stateListener).not.toBeNull())

    reserveFileTranscription()
    act(() => {
      stateListener?.({ payload: fileSnapshot({ sequence: 1, phase: 'transcribing', resourcesReleased: false, error: null }) })
    })
    expect(screen.getByText('Could not restore file transcription state: The local engine is busy. Finish the current local recording or subtitles first.')).toBeTruthy()

    native.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) =>
      command === 'get_file_transcription_state'
        ? fileSnapshot({ sequence: 1, phase: 'transcribing', resourcesReleased: false, error: null })
        : native.defaultInvoke(command, args),
    )
    const queriesBefore = native.invoke.mock.calls.filter(([command]) => command === 'get_file_transcription_state').length
    fireEvent.click(screen.getByRole('button', { name: 'Retry restore' }))

    await waitFor(() => expect(
      native.invoke.mock.calls.filter(([command]) => command === 'get_file_transcription_state').length,
    ).toBeGreaterThan(queriesBefore))
    expect(screen.getByText('Could not restore file transcription state: The local engine is busy. Finish the current local recording or subtitles first.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry restore' })).toBeTruthy()

    releaseFileTranscription()
    fireEvent.click(screen.getByRole('button', { name: 'Retry restore' }))
    await waitFor(() => {
      expect(screen.queryByText(/Could not restore file transcription state/)).toBeNull()
      expect(screen.getByText('Transcribing')).toBeTruthy()
    })
  })

  it('does not suppress the restore failure behind an unrelated page error', async () => {
    renderPage()
    await waitFor(() => expect(stateListener).not.toBeNull())

    dialog.open.mockResolvedValue('C:/recording.mp4')
    native.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'inspect_transcription_file') throw new Error('probe failed')
      return native.defaultInvoke(command, args)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Choose audio or video file' }))
    await waitFor(() => expect(screen.getByText('Could not inspect this file: probe failed')).toBeTruthy())

    reserveFileTranscription()
    act(() => {
      stateListener?.({ payload: fileSnapshot({ sequence: 1, phase: 'transcribing', resourcesReleased: false, error: null }) })
    })

    expect(screen.getByText('Could not inspect this file: probe failed')).toBeTruthy()
    expect(screen.getByText('Could not restore file transcription state: The local engine is busy. Finish the current local recording or subtitles first.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry restore' })).toBeTruthy()
    releaseFileTranscription()
  })

  it('keeps Start disabled and explains why when the selected cloud profile is not configured', async () => {
    cloudProfiles.loadAsrProfiles.mockResolvedValue({
      profiles: [cloudProfile({ apiKey: '' })],
      activeId: 'cloud-profile-1',
    })
    dialog.open.mockResolvedValueOnce('C:/recording.mp4').mockResolvedValueOnce('C:/output')
    renderPage()

    await waitFor(() => expect(screen.getByText('SenseVoice Small')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Cloud' }))

    await waitFor(() => expect(screen.getByText('The selected cloud profile is not ready: no API key yet')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Choose audio or video file' }))
    await waitFor(() => expect(screen.getByText('C:/recording.mp4')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Choose output folder' }))
    await waitFor(() => expect(screen.getByText('C:/output')).toBeTruthy())

    const startButton = screen.getByRole('button', { name: 'Start transcription' })
    expect((startButton as HTMLButtonElement).disabled).toBe(true)
  })

  it('refreshes engine settings and keeps the chosen cloud profile when the language changes', async () => {
    cloudProfiles.loadAsrProfiles.mockResolvedValue({
      profiles: [
        cloudProfile(),
        cloudProfile({ id: 'cloud-profile-2', provider: 'openai_transcribe', model: 'whisper-1' }),
      ],
      activeId: 'cloud-profile-1',
    })
    renderPage()

    await waitFor(() => expect(screen.getByText('SenseVoice Small')).toBeTruthy())
    const downloadsBefore = native.invoke.mock.calls.filter(([command]) => command === 'list_downloaded_models').length
    const loadsBefore = cloudProfiles.loadAsrProfiles.mock.calls.length

    fireEvent.click(screen.getByRole('button', { name: 'Cloud' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cloud profile' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Cloud profile' }))
    fireEvent.click(screen.getByRole('button', { name: 'OpenAI transcription · whisper-1' }))
    expect(screen.getByText('whisper-1')).toBeTruthy()

    act(() => { setLocale('uk') })

    await waitFor(() => expect(
      native.invoke.mock.calls.filter(([command]) => command === 'list_downloaded_models').length,
    ).toBeGreaterThan(downloadsBefore))
    await waitFor(() => expect(cloudProfiles.loadAsrProfiles.mock.calls.length).toBeGreaterThan(loadsBefore))
    await waitFor(() => expect(screen.getByText('whisper-1')).toBeTruthy())
  })

  it('ignores a stale cloud profile response that arrives after the language change', async () => {
    native.settings.set('fileTranscription.engine', 'cloud')
    let resolveFirst: (value: { profiles: AsrProfile[]; activeId: string }) => void = () => undefined
    const firstLoad = new Promise<{ profiles: AsrProfile[]; activeId: string }>((resolve) => { resolveFirst = resolve })
    cloudProfiles.loadAsrProfiles
      .mockImplementationOnce(async () => firstLoad)
      .mockResolvedValueOnce({
        profiles: [cloudProfile({ id: 'cloud-profile-2', provider: 'openai_transcribe', model: 'whisper-1' })],
        activeId: 'cloud-profile-2',
      })
    renderPage()

    await waitFor(() => expect(cloudProfiles.loadAsrProfiles).toHaveBeenCalledTimes(1))

    act(() => { setLocale('uk') })

    await waitFor(() => expect(cloudProfiles.loadAsrProfiles).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByText('whisper-1')).toBeTruthy())

    resolveFirst({ profiles: [cloudProfile()], activeId: 'cloud-profile-1' })
    await act(async () => {})

    expect(screen.getByText('whisper-1')).toBeTruthy()
    expect(screen.queryByText('nova-3')).toBeNull()
  })

  it('restarts the copy reset timer when copying again', async () => {
    renderPage()
    await waitFor(() => expect(stateListener).not.toBeNull())
    act(() => {
      stateListener?.({ payload: fileSnapshot({ jobId: 'job-copy', sequence: 1, phase: 'completed', resourcesReleased: true, error: null }) })
    })

    vi.useFakeTimers()
    try {
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy text' })) })
      expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy()

      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      fireEvent.click(screen.getByRole('button', { name: 'Copied' }))
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy()

      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
      expect(screen.getByRole('button', { name: 'Copy text' })).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
})
