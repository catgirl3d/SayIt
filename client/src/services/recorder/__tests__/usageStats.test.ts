import { beforeEach, describe, expect, it, vi } from 'vitest'

const bridge = vi.hoisted(() => ({
  appendDebugLog: vi.fn(),
  emit: vi.fn().mockResolvedValue(undefined),
}))

const provider = vi.hoisted(() => ({
  cancel: vi.fn(),
  mode: 'server',
  stop: vi.fn(),
}))

const audio = vi.hoisted(() => ({
  startCapture: vi.fn(),
  stopCapture: vi.fn().mockResolvedValue(undefined),
}))

const store = vi.hoisted(() => ({
  addHistory: vi.fn(),
  deleteHistory: vi.fn(),
  getActivePresetId: vi.fn(),
  getPromptPresets: vi.fn(),
  getSetting: vi.fn(),
  recordStats: vi.fn(),
  setActivePresetId: vi.fn(),
}))

const textPostProcess = vi.hoisted(() => ({
  applyTextTransforms: vi.fn(),
}))

vi.mock('../../bridge', () => bridge)
vi.mock('../../audio', () => audio)
vi.mock('../../store', () => store)
vi.mock('../../textPostProcess', () => textPostProcess)
vi.mock('../../transcription', () => ({ getProvider: vi.fn(() => provider) }))

import { RecorderOrchestrator } from '../RecorderOrchestrator'

type FinalCallback = (result: {
  asrText: string
  llmText: string
  asrMs: number
  llmMs: number
  durationSec: number
}) => void

type TestOrchestrator = Record<string, unknown> & {
  activeRunId: number
  buildProviderCallbacks: () => { onFinal?: FinalCallback }
  overlayService: { showNoSpeech: ReturnType<typeof vi.fn> }
}

function createOrchestrator() {
  const orchestrator = Object.create(RecorderOrchestrator.prototype) as TestOrchestrator
  Object.assign(orchestrator, {
    activeRunId: 7,
    audioSentSamples: 32000,
    currentActiveAppContext: null,
    currentPromptResolution: null,
    finalHandledInCurrentRun: false,
    processingTimeoutId: null,
    recordedChunks: [],
    state: 'processing',
    wallTimeAtStopSec: 2,
  })
  orchestrator.clearProcessingTimeout = vi.fn()
  orchestrator.finishRun = vi.fn()
  orchestrator.resetToIdle = vi.fn()
  orchestrator.buildHistoryMetadata = vi.fn().mockReturnValue({})
  orchestrator.buildProviderMetadata = vi.fn().mockResolvedValue({})
  orchestrator.updatePersonalizationFromFinal = vi.fn().mockResolvedValue(undefined)
  orchestrator.handleTextInsertion = vi.fn().mockResolvedValue(undefined)
  orchestrator.overlayService = {
    showNoSpeech: vi.fn(),
  }
  return orchestrator
}

describe('history-disabled usage stats', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    textPostProcess.applyTextTransforms.mockImplementation(async (text: string) => text)
  })

  it('records text usage once when history is disabled', async () => {
    const orchestrator = createOrchestrator()
    store.getSetting.mockResolvedValue(false)
    store.recordStats.mockResolvedValue({ totalDurationSec: 2, totalChars: 5 })

    orchestrator.buildProviderCallbacks().onFinal?.({
      asrText: 'hello',
      llmText: 'hello',
      asrMs: 10,
      llmMs: 0,
      durationSec: 2,
    })

    await vi.waitFor(() => expect(store.recordStats).toHaveBeenCalledWith(5, 2))
    expect(store.recordStats).toHaveBeenCalledTimes(1)
    expect(store.addHistory).not.toHaveBeenCalled()
    expect(bridge.emit).toHaveBeenCalledWith('stats-updated')
  })

  it('does not record usage when the final result has no text', async () => {
    const orchestrator = createOrchestrator()
    store.getSetting.mockResolvedValue(false)

    orchestrator.buildProviderCallbacks().onFinal?.({
      asrText: '',
      llmText: '',
      asrMs: 10,
      llmMs: 0,
      durationSec: 2,
    })

    await vi.waitFor(() => expect(orchestrator.overlayService.showNoSpeech).toHaveBeenCalled())
    expect(store.recordStats).not.toHaveBeenCalled()
  })

  it('does not write usage stats directly when history is enabled', async () => {
    const orchestrator = createOrchestrator()
    store.getSetting.mockResolvedValue(true)
    store.addHistory.mockResolvedValue(undefined)

    orchestrator.buildProviderCallbacks().onFinal?.({
      asrText: 'hello',
      llmText: 'hello',
      asrMs: 10,
      llmMs: 0,
      durationSec: 2,
    })

    await vi.waitFor(() => expect(store.addHistory).toHaveBeenCalled())
    expect(store.recordStats).not.toHaveBeenCalled()
  })

  it('keeps delivering text and skips the stats event when recording fails', async () => {
    const orchestrator = createOrchestrator()
    store.getSetting.mockResolvedValue(false)
    store.recordStats.mockRejectedValue(new Error('db unavailable'))

    orchestrator.buildProviderCallbacks().onFinal?.({
      asrText: 'hello',
      llmText: 'hello',
      asrMs: 10,
      llmMs: 0,
      durationSec: 2,
    })

    await vi.waitFor(() => expect(orchestrator.handleTextInsertion).toHaveBeenCalled())
    expect(store.recordStats).toHaveBeenCalledTimes(1)
    expect(bridge.emit).not.toHaveBeenCalledWith('stats-updated')
  })
})
