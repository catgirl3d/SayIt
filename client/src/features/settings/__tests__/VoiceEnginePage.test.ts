import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type WorkMode = 'server' | 'cloud_api' | 'local'
type WorkModeProps = { value: WorkMode; onChange: (mode: WorkMode) => void }

const pageMocks = vi.hoisted(() => ({
  workModeProps: [] as WorkModeProps[],
  stateValues: [] as unknown[],
  stateCursor: 0,
  stop: vi.fn(),
  getSnapshot: vi.fn(),
  setSetting: vi.fn(),
  switchProvider: vi.fn(),
  setEngineDraftDirty: vi.fn(),
  refreshRecorderSettings: vi.fn(),
  reconnectProvider: vi.fn(),
  refreshModeStatus: vi.fn(),
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: <T,>(initial: T): [T, (next: T | ((previous: T) => T)) => void] => {
      const index = pageMocks.stateCursor++
      if (!(index in pageMocks.stateValues)) pageMocks.stateValues[index] = initial
      return [pageMocks.stateValues[index] as T, (next) => {
        pageMocks.stateValues[index] = typeof next === 'function'
          ? (next as (previous: T) => T)(pageMocks.stateValues[index] as T)
          : next
      }]
    },
    useEffect: () => undefined,
  }
})

vi.mock('@/services/store', () => ({
  getSetting: vi.fn(),
  setSetting: pageMocks.setSetting,
}))

vi.mock('@/services/transcription', () => ({
  getWorkMode: () => 'server',
  switchProvider: pageMocks.switchProvider,
}))

vi.mock('@/services/recorder', () => ({
  refreshRecorderSettings: pageMocks.refreshRecorderSettings,
  reconnectProvider: pageMocks.reconnectProvider,
  setSpeechLanguageCache: vi.fn(),
}))

vi.mock('@/services/speechInputLanguage', () => ({
  getSpeechInputLanguage: vi.fn(),
  setSpeechInputLanguage: vi.fn(),
}))

vi.mock('@/stores/modeStatus', () => ({ refreshModeStatus: pageMocks.refreshModeStatus }))
vi.mock('@/stores/engineDraft', () => ({ setEngineDraftDirty: pageMocks.setEngineDraftDirty }))
vi.mock('@/services/systemAudio', () => ({
  systemAudioSession: {
    stop: pageMocks.stop,
    getSnapshot: pageMocks.getSnapshot,
  },
}))
vi.mock('@/i18n/useT', () => ({ useT: () => (key: string) => (
  key === 'systemAudio.cleanupFailed'
    ? 'Could not safely return to dictation. Try stopping subtitles again.'
    : key
) }))

vi.mock('../WorkModeSection', () => ({
  default: (props: WorkModeProps) => {
    pageMocks.workModeProps.push(props)
    return null
  },
}))
vi.mock('../CloudAPISection', () => ({ default: () => null }))
vi.mock('../LocalModeSection', () => ({ default: () => null, LocalModeAdvancedSection: () => null }))
vi.mock('../ServerSection', () => ({ default: () => null }))
vi.mock('../AsrTestSection', () => ({ default: () => null }))
vi.mock('../SpeechLanguageSection', () => ({ default: () => null }))

import VoiceEnginePage from '../VoiceEnginePage'

describe('voice engine work mode changes', () => {
  beforeEach(() => {
    pageMocks.workModeProps.length = 0
    pageMocks.stateValues.length = 0
    pageMocks.stateCursor = 0
    pageMocks.stop.mockReset().mockResolvedValue(undefined)
    pageMocks.getSnapshot.mockReset().mockReturnValue({
      state: 'error',
      caption: '',
      error: 'Native subtitle cleanup failed',
      warning: '',
      captionNotice: '',
      source: '',
      liveOriginal: '',
      liveRecognition: false,
    })
    pageMocks.setSetting.mockReset().mockResolvedValue(undefined)
    pageMocks.switchProvider.mockReset().mockResolvedValue(undefined)
    pageMocks.setEngineDraftDirty.mockReset()
    pageMocks.refreshRecorderSettings.mockReset().mockResolvedValue(undefined)
    pageMocks.reconnectProvider.mockReset()
    pageMocks.refreshModeStatus.mockReset().mockResolvedValue(undefined)
  })

  it('shows the subtitle cleanup error and does not switch mode when stop does not reach idle', async () => {
    renderToStaticMarkup(createElement(VoiceEnginePage))
    const workMode = pageMocks.workModeProps[pageMocks.workModeProps.length - 1]
    expect(workMode).toBeDefined()

    workMode!.onChange('local')
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    pageMocks.stateCursor = 0
    pageMocks.workModeProps.length = 0
    const markup = renderToStaticMarkup(createElement(VoiceEnginePage))

    expect(markup).toContain('<p role="alert" class="text-sm leading-6 text-destructive">Native subtitle cleanup failed</p>')
    expect(pageMocks.setSetting).not.toHaveBeenCalledWith('workMode', 'local')
    expect(pageMocks.switchProvider).not.toHaveBeenCalled()
    expect(pageMocks.setEngineDraftDirty).not.toHaveBeenCalled()
    expect(pageMocks.refreshRecorderSettings).not.toHaveBeenCalled()
    expect(pageMocks.reconnectProvider).not.toHaveBeenCalled()
  })
})
