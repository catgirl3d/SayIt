// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FileTranscriptionService, type FileTranscriptionBridge } from '../../fileTranscription'

const state = vi.hoisted(() => ({
  provider: {
    mode: 'local' as 'local' | 'cloud_api',
    isReady: vi.fn(() => true),
    connect: vi.fn(async () => undefined),
    start: vi.fn(() => true),
    cancel: vi.fn(),
    disconnect: vi.fn(),
    sendAudio: vi.fn(),
  },
  invoke: vi.fn(async (command: string, _args?: Record<string, unknown>): Promise<unknown> => {
    if (command === 'present_overlay') return 1
    if (command === 'get_mic_mute_state') return { matched: false, muted: false }
    if (command === 'get_recording_context') return {
      appContext: null,
      probe: { probeId: 1, editable: false, verdict: 'not_editable' },
    }
    return undefined
  }),
  startCapture: vi.fn(async () => ({ label: 'Test microphone' })),
  stopCapture: vi.fn(async () => undefined),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: (command: string, args?: Record<string, unknown>) => state.invoke(command, args) }))
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(),
  listen: vi.fn(async () => () => undefined),
}))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn() }))
vi.mock('../../audio', () => ({
  startCapture: () => state.startCapture(),
  stopCapture: () => state.stopCapture(),
}))
vi.mock('@/services/transcription', () => ({ getProvider: () => state.provider }))

import { RecorderOrchestrator } from '../RecorderOrchestrator'

describe('file transcription recorder admission', () => {
  beforeEach(() => {
    state.provider.mode = 'local'
    state.provider.isReady.mockReset().mockReturnValue(true)
    state.provider.connect.mockReset().mockResolvedValue(undefined)
    state.provider.start.mockReset().mockReturnValue(true)
    state.provider.cancel.mockReset()
    state.provider.disconnect.mockReset()
    state.invoke.mockClear()
    state.startCapture.mockReset().mockResolvedValue({ label: 'Test microphone' })
    state.stopCapture.mockReset().mockResolvedValue(undefined)
  })

  it('rejects a local hotkey start before provider readiness or microphone capture', async () => {
    const recorder = new RecorderOrchestrator()
    recorder.setFileTranscriptionAdmissionReady(true)
    recorder.reserveFileTranscription()

    await recorder.startRecording()

    expect(state.provider.isReady).not.toHaveBeenCalled()
    expect(state.startCapture).not.toHaveBeenCalled()
  })

  it('rejects file admission while local dictation startup still owns the start lock', async () => {
    let resolveContext!: (value: unknown) => void
    const contextPromise = new Promise((resolve) => { resolveContext = resolve })
    state.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_recording_context') return contextPromise
      if (command === 'present_overlay') return 1
      if (command === 'get_mic_mute_state') return { matched: false, muted: false }
      return undefined
    })
    const recorder = new RecorderOrchestrator()
    recorder.setFileTranscriptionAdmissionReady(true)
    const starting = recorder.startRecording()
    await Promise.resolve()

    expect(() => recorder.reserveFileTranscription()).toThrow()
    expect(state.startCapture).not.toHaveBeenCalled()

    const ipc = {
      listen: vi.fn(async <T>(_event: string, _handler: (event: { payload: T }) => void) => () => undefined),
      invoke: vi.fn(async <T>(command: string, _args?: Record<string, unknown>) => (command === 'get_file_transcription_state' ? null : undefined) as T),
    } as unknown as FileTranscriptionBridge
    const service = new FileTranscriptionService(ipc, recorder)
    await expect(service.startWithCurrentSettings({
      filePath: 'C:/recording.mp4',
      outputDirectory: 'C:/output',
      ffmpegDirectory: null,
      audioStreamIndex: 0,
    })).rejects.toThrow()
    expect(ipc.invoke).not.toHaveBeenCalledWith('start_file_transcription', expect.anything())

    resolveContext({
      appContext: null,
      probe: { probeId: 1, editable: false, verdict: 'not_editable' },
    })
    await starting
    recorder.cleanup()
  })

  it('allows cloud dictation to continue while a file owns local admission', async () => {
    state.provider.mode = 'cloud_api'
    const recorder = new RecorderOrchestrator()
    recorder.reserveFileTranscription()

    await recorder.startRecording()

    expect(state.startCapture).toHaveBeenCalledTimes(1)
    recorder.cleanup()
  })
})
