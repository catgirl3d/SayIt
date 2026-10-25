// @vitest-environment jsdom
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const lifecycle = vi.hoisted(() => ({
  events: [] as string[],
  initRecorder: vi.fn(),
  cleanupRecorder: vi.fn(),
  initFileTranscription: vi.fn(),
  initTheme: vi.fn(),
  initAiEnabled: vi.fn(),
  initActivePreset: vi.fn(),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  startUpdateService: vi.fn(),
  startWebDavBackupService: vi.fn(),
  listen: vi.fn(),
  stopSystemAudio: vi.fn(),
}))

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

vi.mock('./components/Sidebar', () => ({ default: () => null }))
vi.mock('./components/TitleBar', () => ({ default: () => null }))
vi.mock('./components/WelcomeGuide', () => ({ default: () => null }))
vi.mock('./pages/Home', () => ({ default: () => null }))
vi.mock('./pages/FileTranscription', () => ({ default: () => null }))
vi.mock('./pages/SystemAudio', () => ({ default: () => null }))
vi.mock('./pages/History', () => ({ default: () => null }))
vi.mock('./pages/Dictionary', () => ({ default: () => null }))
vi.mock('./features/settings/VoiceEnginePage', () => ({ default: () => null }))
vi.mock('./features/settings/AIServicePage', () => ({ default: () => null }))
vi.mock('./features/settings/AIInstructionsPage', () => ({ default: () => null }))
vi.mock('./features/settings/AudioSettingsPage', () => ({ default: () => null }))
vi.mock('./features/settings/ShortcutsSettingsPage', () => ({ default: () => null }))
vi.mock('./features/settings/GeneralSettingsPage', () => ({ default: () => null }))
vi.mock('./features/settings/AppearancePage', () => ({ default: () => null }))
vi.mock('./features/settings/PersonalizationPage', () => ({ default: () => null }))
vi.mock('./features/settings/DiagnosticsPage', () => ({ default: () => null }))
vi.mock('./pages/About', () => ({ default: () => null }))
vi.mock('./features/update/UpdateDialog', () => ({ default: () => null }))

vi.mock('./services/recorder', () => ({
  initRecorder: (...args: unknown[]) => lifecycle.initRecorder(...args),
  cleanup: (...args: unknown[]) => lifecycle.cleanupRecorder(...args),
}))
vi.mock('./services/fileTranscription', () => ({
  fileTranscriptionService: {
    init: (...args: unknown[]) => lifecycle.initFileTranscription(...args),
  },
}))
vi.mock('./stores/theme', () => ({ initTheme: (...args: unknown[]) => lifecycle.initTheme(...args) }))
vi.mock('./stores/aiEnabled', () => ({ initAiEnabled: (...args: unknown[]) => lifecycle.initAiEnabled(...args) }))
vi.mock('./stores/activePreset', () => ({ initActivePreset: (...args: unknown[]) => lifecycle.initActivePreset(...args) }))
vi.mock('./services/store', () => ({
  getSetting: (...args: unknown[]) => lifecycle.getSetting(...args),
  setSetting: (...args: unknown[]) => lifecycle.setSetting(...args),
}))
vi.mock('./features/update/autoUpdate', () => ({
  startUpdateService: (...args: unknown[]) => lifecycle.startUpdateService(...args),
}))
vi.mock('./features/backup/autoWebdavBackup', () => ({
  startWebDavBackupService: (...args: unknown[]) => lifecycle.startWebDavBackupService(...args),
}))
vi.mock('./services/bridge', () => ({ notifyShortcutsChanged: vi.fn() }))
vi.mock('./services/systemAudio', () => ({
  systemAudioSession: { stop: (...args: unknown[]) => lifecycle.stopSystemAudio(...args) },
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: (...args: unknown[]) => lifecycle.listen(...args) }))

import App from './App'

function renderApp(runtimeConfigReady: boolean) {
  return render(
    <MemoryRouter>
      <App runtimeConfigReady={runtimeConfigReady} />
    </MemoryRouter>,
  )
}

describe('App startup recorder admission', () => {
  beforeEach(() => {
    lifecycle.events.length = 0
    lifecycle.initRecorder.mockReset().mockImplementation(async () => { lifecycle.events.push('recorder') })
    lifecycle.cleanupRecorder.mockReset().mockImplementation(() => { lifecycle.events.push('cleanup') })
    lifecycle.initFileTranscription.mockReset().mockImplementation(async () => { lifecycle.events.push('file') })
    lifecycle.initTheme.mockReset().mockResolvedValue(undefined)
    lifecycle.initAiEnabled.mockReset().mockResolvedValue(undefined)
    lifecycle.initActivePreset.mockReset().mockResolvedValue(undefined)
    lifecycle.getSetting.mockReset().mockResolvedValue('onboarded')
    lifecycle.setSetting.mockReset().mockResolvedValue(undefined)
    lifecycle.startUpdateService.mockReset().mockImplementation(async () => { lifecycle.events.push('update') })
    lifecycle.startWebDavBackupService.mockReset().mockImplementation(async () => { lifecycle.events.push('webdav') })
    lifecycle.listen.mockReset().mockResolvedValue(vi.fn())
    lifecycle.stopSystemAudio.mockReset().mockImplementation(async () => { lifecycle.events.push('stop') })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('keeps the app rendered and restores files without starting the recorder when runtime config is unavailable', async () => {
    const fileRestore = deferred<void>()
    lifecycle.initFileTranscription.mockImplementationOnce(() => {
      lifecycle.events.push('file')
      return fileRestore.promise
    })
    const view = renderApp(false)

    await waitFor(() => expect(screen.getByRole('main')).toBeTruthy())
    await waitFor(() => expect(lifecycle.initFileTranscription).toHaveBeenCalledOnce())

    expect(lifecycle.events).toEqual(['file'])
    expect(lifecycle.initRecorder).not.toHaveBeenCalled()

    fileRestore.resolve()
    await waitFor(() => expect(lifecycle.events).toEqual(['file', 'update', 'webdav']))
    expect(lifecycle.initRecorder).not.toHaveBeenCalled()

    view.unmount()
    await waitFor(() => expect(lifecycle.events.slice(-2)).toEqual(['stop', 'cleanup']))
  })

  it('keeps the existing recorder startup when runtimeConfigReady is true', async () => {
    const fileRestore = deferred<void>()
    lifecycle.initFileTranscription.mockImplementationOnce(() => {
      lifecycle.events.push('file')
      return fileRestore.promise
    })
    renderApp(true)

    await waitFor(() => expect(lifecycle.initFileTranscription).toHaveBeenCalledOnce())
    expect(lifecycle.events).toEqual(['file'])
    expect(lifecycle.initRecorder).not.toHaveBeenCalled()

    fileRestore.resolve()
    await waitFor(() => expect(lifecycle.events).toEqual(['file', 'recorder', 'update', 'webdav']))
    expect(lifecycle.initRecorder).toHaveBeenCalledOnce()
  })
})
