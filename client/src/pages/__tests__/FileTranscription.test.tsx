// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, act, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import FileTranscription from '../FileTranscription'
import type { FileTranscriptionSnapshot } from '@/services/fileTranscription'

const native = vi.hoisted(() => {
  const defaultInvoke = async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    if (command === 'get_file_transcription_state') return null
    if (command === 'store_get') {
      if (args?.key === 'speechInput.language') return 'en'
      if (args?.key === 'localAsr.modelId') return 'sensevoice-small-gguf'
      if (args?.key === 'localAsr.accelerator') return 'auto'
      return null
    }
    if (command === 'list_available_models') return [{ id: 'sensevoice-small-gguf', name: 'SenseVoice Small' }]
    if (command === 'list_downloaded_models') return [{ id: 'sensevoice-small-gguf', complete: true }]
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
  }
})

const dialog = vi.hoisted(() => ({ open: vi.fn() }))
let detectedFfmpegDirectory: string | null = null
let stateListener: ((event: { payload: FileTranscriptionSnapshot }) => void) | null = null

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

function fileSnapshot(overrides: Partial<FileTranscriptionSnapshot> = {}): FileTranscriptionSnapshot {
  return {
    jobId: 'job-1',
    sequence: 1,
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
    ...overrides,
  }
}

describe('file transcription page', () => {
  beforeEach(() => {
    native.invoke.mockClear()
    native.invoke.mockImplementation(native.defaultInvoke)
    native.listen.mockClear()
    dialog.open.mockReset()
    detectedFfmpegDirectory = null
  })

  it('shows the file picker workflow and existing local engine summary', async () => {
    render(<FileTranscription />)

    expect(screen.getByRole('heading', { name: 'Transcribe a file' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Choose audio or video file' })).toBeTruthy()
    await waitFor(() => expect(screen.getByText('SenseVoice Small')).toBeTruthy())
    expect(screen.getByText('English')).toBeTruthy()
    expect(screen.getByText('Auto')).toBeTruthy()
  })

  it('retries local settings after a settings error', async () => {
    native.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'list_available_models') throw new Error('engine offline')
      return native.defaultInvoke(command, args)
    })

    render(<FileTranscription />)

    await waitFor(() => expect(screen.getByText('Could not read local engine settings: engine offline')).toBeTruthy())
    expect(screen.queryByText('SenseVoice Small')).toBeNull()

    native.invoke.mockImplementation(native.defaultInvoke)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(screen.getByText('SenseVoice Small')).toBeTruthy())
    expect(screen.queryByText('Could not read local engine settings: engine offline')).toBeNull()
  })

  it('preselects the default physical audio track instead of the first track', async () => {
    dialog.open.mockResolvedValue('C:/recording.mp4')
    render(<FileTranscription />)

    fireEvent.click(screen.getByRole('button', { name: 'Choose audio or video file' }))

    await waitFor(() => {
      const trackTrigger = screen.getByRole('button', { name: 'Audio track' })
      expect(trackTrigger.textContent).toContain('Default track')
    })
  })

  it('shows retry export only for a released retryable export failure', async () => {
    render(<FileTranscription />)
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
    render(<FileTranscription />)
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

  it('cancels exactly once only after confirmation', async () => {
    render(<FileTranscription />)
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
    render(<FileTranscription />)
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

  it('uses a destructive style for the cancellation confirmation', async () => {
    render(<FileTranscription />)
    await waitFor(() => expect(stateListener).not.toBeNull())
    act(() => {
      stateListener?.({ payload: fileSnapshot({
        jobId: 'job-cancel-1',
        sequence: 13,
        phase: 'transcribing',
        resourcesReleased: false,
        error: null,
      }) })
    })

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    const confirmButton = within(screen.getByRole('dialog')).getByRole('button', { name: 'Stop transcription' })

    expect(confirmButton.className).toContain('destructive')
    expect(confirmButton.className).not.toContain('bg-primary')
  })

  it('shows truthful preparation progress and no progress for checking or loading', async () => {
    render(<FileTranscription />)
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
        resourcesReleased: true,
      }) })
    })
    expect(screen.queryByLabelText('Processed audio progress')).toBeNull()
    expect(screen.queryByText('Processed 0:05')).toBeNull()
  })

  it('shows saved progress while transcribing', async () => {
    render(<FileTranscription />)
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
    render(<FileTranscription />)
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
    render(<FileTranscription />)
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
    render(<FileTranscription />)
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
        phase: 'finalizing',
        resourcesReleased: true,
        error: null,
      }) })
    })
  })

  it('offers a detected FFmpeg folder and re-inspects the selected file when used', async () => {
    detectedFfmpegDirectory = 'C:/tools/ffmpeg'
    dialog.open.mockResolvedValue('C:/recording.mp4')
    render(<FileTranscription />)

    await waitFor(() => expect(screen.getByText('C:/tools/ffmpeg')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Choose audio or video file' }))
    await waitFor(() => expect(screen.getByText('C:/recording.mp4')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Use this folder' }))

    await waitFor(() => expect(native.invoke).toHaveBeenCalledWith('inspect_transcription_file', {
      filePath: 'C:/recording.mp4',
      ffmpegDirectory: 'C:/tools/ffmpeg',
    }))
  })

  it('dismisses a detected FFmpeg folder suggestion for the session', async () => {
    detectedFfmpegDirectory = 'C:/tools/ffmpeg'
    render(<FileTranscription />)

    await waitFor(() => expect(screen.getByText('C:/tools/ffmpeg')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

    expect(screen.queryByText('C:/tools/ffmpeg')).toBeNull()
  })

  it('hides the detected suggestion after the user chooses a folder manually', async () => {
    detectedFfmpegDirectory = 'C:/tools/ffmpeg'
    dialog.open.mockResolvedValue('C:/manual/ffmpeg')
    render(<FileTranscription />)

    await waitFor(() => expect(screen.getByText('C:/tools/ffmpeg')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }))

    await waitFor(() => expect(screen.getByText('C:/manual/ffmpeg')).toBeTruthy())
    expect(screen.queryByText('C:/tools/ffmpeg')).toBeNull()
  })

  it('shows no FFmpeg suggestion when detection returns no candidate', async () => {
    render(<FileTranscription />)

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
      if (command === 'list_available_models') return [{ id: 'sensevoice-small-gguf', name: 'SenseVoice Small' }]
      if (command === 'list_downloaded_models') return [{ id: 'sensevoice-small-gguf', complete: true }]
      if (command === 'get_file_transcription_state') return null
      return undefined
    })
    render(<FileTranscription />)

    await waitFor(() => expect(screen.getByText('SenseVoice Small')).toBeTruthy())
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText('Use this folder')).toBeNull()
  })

  it('renders a backend warning as a separate non-error notice', async () => {
    render(<FileTranscription />)
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
    render(<FileTranscription />)
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
    render(<FileTranscription />)
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
})
