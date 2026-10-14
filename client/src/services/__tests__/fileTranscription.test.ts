import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FileTranscriptionService,
  type FileTranscriptionBridge,
  type FileTranscriptionSnapshot,
} from '../fileTranscription'

function snapshot(overrides: Partial<FileTranscriptionSnapshot> = {}): FileTranscriptionSnapshot {
  return {
    jobId: 'job-1',
    sequence: 1,
    phase: 'transcribing',
    filePath: 'C:/recording.mp4',
    durationMs: 120_000,
    processedMs: 60_000,
    savedMs: 60_000,
    text: 'Saved text',
    draftPath: 'C:/output/job-1.partial.txt',
    txtPath: null,
    markdownPath: null,
    error: null,
    warning: null,
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
  }
  const bridge = { invoke, listen } as unknown as FileTranscriptionBridge
  return { calls, invoke, listen, admission, bridge }
}

describe('file transcription service', () => {
  beforeEach(() => vi.restoreAllMocks())

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

  it('keeps initialization failures visible instead of returning a fake ready state', async () => {
    const harness = createHarness()
    harness.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_file_transcription_state') throw new Error('state query failed')
      return undefined
    })
    const service = new FileTranscriptionService(harness.bridge, harness.admission)

    await expect(service.init()).rejects.toThrow('state query failed')

    expect(service.getInitializationError()).toBe('state query failed')
    expect(harness.admission.reserveFileTranscription).not.toHaveBeenCalled()
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
})
