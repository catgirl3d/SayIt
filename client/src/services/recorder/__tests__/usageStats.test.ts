import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptionCallbacks, WorkMode } from '../../transcription'

const bridge = vi.hoisted(() => ({
  appendDebugLog: vi.fn(),
  emit: vi.fn().mockResolvedValue(undefined),
  hideOverlay: vi.fn().mockResolvedValue(undefined),
  pasteText: vi.fn().mockResolvedValue({ ok: true, strategy: 'sendinput' }),
  presentOverlay: vi.fn().mockResolvedValue(0),
  setEscapeActionMode: vi.fn().mockResolvedValue(undefined),
  updateOverlay: vi.fn().mockResolvedValue(undefined),
}))

const provider = vi.hoisted(() => ({
  cancel: vi.fn(),
  mode: 'server' as WorkMode,
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
  recordUsage: vi.fn(),
  setActivePresetId: vi.fn(),
}))

const personalization = vi.hoisted(() => ({ getUserStats: vi.fn() }))

const textPostProcess = vi.hoisted(() => ({
  applyTextTransforms: vi.fn(),
}))

vi.mock('../../bridge', () => bridge)
vi.mock('../../audio', () => audio)
vi.mock('../../store', () => store)
vi.mock('../../personalization/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../personalization/store')>()),
  getUserStats: personalization.getUserStats,
}))
vi.mock('../../textPostProcess', () => textPostProcess)
vi.mock('../../transcription', () => ({ getProvider: vi.fn(() => provider) }))

import { RecorderOrchestrator } from '../RecorderOrchestrator'

type TestOrchestrator = Record<string, unknown> & {
  activeRunId: number
  overlayService: { showNoSpeech: ReturnType<typeof vi.fn> }
}

function callbacksFor(recorder: RecorderOrchestrator | TestOrchestrator): TranscriptionCallbacks {
  return (recorder as RecorderOrchestrator).testSeam().buildProviderCallbacks()
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
  orchestrator.handleTextInsertion = vi.fn().mockResolvedValue(undefined)
  orchestrator.overlayService = {
    showNoSpeech: vi.fn(),
  }
  return orchestrator
}

const FINAL = { asrText: 'hello', llmText: 'hello', asrMs: 10, llmMs: 0, durationSec: 2 }
const EXPECTED_EVENT = { charCount: 5, durationSec: 2, appId: 'unknown', workMode: 'server', promptPresetId: undefined }

describe('usage recording', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    textPostProcess.applyTextTransforms.mockImplementation(async (text: string) => text)
    store.recordUsage.mockResolvedValue(undefined)
    store.addHistory.mockResolvedValue(undefined)
    personalization.getUserStats.mockResolvedValue({ totalWords: 5, totalSessions: 1, domainWords: {}, appUsageCount: {} })
  })

  it.each([{ historyEnabled: false }, { historyEnabled: true }])(
    'records exactly one usage event when history enabled is $historyEnabled',
    async ({ historyEnabled }) => {
      const orchestrator = createOrchestrator()
      store.getSetting.mockResolvedValue(historyEnabled)

      callbacksFor(orchestrator).onFinal?.(FINAL)

      await vi.waitFor(() => expect(store.recordUsage).toHaveBeenCalledWith(EXPECTED_EVENT))
      expect(store.recordUsage).toHaveBeenCalledTimes(1)
      expect(store.addHistory).toHaveBeenCalledTimes(historyEnabled ? 1 : 0)
      await vi.waitFor(() => expect(bridge.emit).toHaveBeenCalledWith('stats-updated'))
    },
  )

  it('does not record usage when the final result has no text', async () => {
    const orchestrator = createOrchestrator()
    store.getSetting.mockResolvedValue(false)

    callbacksFor(orchestrator).onFinal?.({ ...FINAL, asrText: '', llmText: '' })

    await vi.waitFor(() => expect(orchestrator.overlayService.showNoSpeech).toHaveBeenCalled())
    expect(store.recordUsage).not.toHaveBeenCalled()
  })

  it('keeps delivering text and skips the stats event when recording fails', async () => {
    const orchestrator = createOrchestrator()
    store.getSetting.mockResolvedValue(false)
    store.recordUsage.mockRejectedValue(new Error('db unavailable'))

    callbacksFor(orchestrator).onFinal?.(FINAL)

    await vi.waitFor(() => expect(orchestrator.handleTextInsertion).toHaveBeenCalled())
    await vi.waitFor(() => expect(store.recordUsage).toHaveBeenCalledTimes(1))
    expect(bridge.emit).not.toHaveBeenCalledWith('stats-updated')
  })
})
