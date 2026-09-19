import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Module boundaries are mocked wholesale: this suite locks the service's state
// machine and preferences, not the IPC plumbing (covered by the Rust task) or the
// manifest contract (covered by updateChecker tests).
const bridgeState = vi.hoisted(() => ({
  clearLegacyUpdateArtifacts: vi.fn(),
  downloadUpdate: vi.fn(),
  installDownloadedUpdate: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}))

vi.mock('@/services/bridge', () => ({
  clearLegacyUpdateArtifacts: (...args: unknown[]) => bridgeState.clearLegacyUpdateArtifacts(...args),
  downloadUpdate: (...args: unknown[]) => bridgeState.downloadUpdate(...args),
  installDownloadedUpdate: (...args: unknown[]) => bridgeState.installDownloadedUpdate(...args),
}))

vi.mock('@/services/store', () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}))

vi.mock('@/services/debugLog', () => ({
  addRuntimeEvent: vi.fn(),
}))

vi.mock('../updateChecker', () => ({
  checkVersionUpdate: vi.fn(),
}))

import { checkVersionUpdate, type VersionInfo } from '../updateChecker'
import { getSetting, setSetting } from '@/services/store'

const getSettingMock = vi.mocked(getSetting)
const setSettingMock = vi.mocked(setSetting)
const checkVersionUpdateMock = vi.mocked(checkVersionUpdate)

const AVAILABLE: VersionInfo = {
  hasUpdate: true,
  currentVersion: '0.2.1',
  latestVersion: '0.2.2',
  downloadUrl: 'https://github.com/catgirl3d/SayIt/releases/download/v0.2.2/SayIt_0.2.2_x64-setup.exe',
  releaseDate: '2026-09-19T00:00:00.000Z',
  sha512: 'VALID-SHA512-BASE64==',
  error: null,
  sourceUrl: 'https://github.com/catgirl3d/SayIt/releases/latest/download/latest-win32-x64.json',
}

const UP_TO_DATE: VersionInfo = { ...AVAILABLE, hasUpdate: false, latestVersion: null, downloadUrl: null, sha512: null }

// The singleton state lives at module scope; each test imports a fresh copy.
let service: typeof import('../autoUpdate')

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.clearAllMocks()
  bridgeState.clearLegacyUpdateArtifacts.mockResolvedValue(undefined)
  bridgeState.downloadUpdate.mockResolvedValue(undefined)
  bridgeState.installDownloadedUpdate.mockResolvedValue(undefined)
  setSettingMock.mockResolvedValue(undefined)
  getSettingMock.mockResolvedValue(true)
  checkVersionUpdateMock.mockResolvedValue(UP_TO_DATE)
  service = await import('../autoUpdate')
})

afterEach(() => {
  vi.useRealTimers()
})

const SIX_HOURS_MS = 6 * 60 * 60 * 1000

describe('startUpdateService', () => {
  it('cleans legacy artifacts before reading the automatic-check preference', async () => {
    getSettingMock.mockResolvedValue(false)
    await service.startUpdateService()
    expect(bridgeState.clearLegacyUpdateArtifacts).toHaveBeenCalledTimes(1)
    // The cleanup must not depend on the preference, and must run before it is read.
    expect(getSettingMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      bridgeState.clearLegacyUpdateArtifacts.mock.invocationCallOrder[0],
    )
  })

  it('survives a legacy cleanup failure without blocking startup', async () => {
    bridgeState.clearLegacyUpdateArtifacts.mockRejectedValue(new Error('storage locked'))
    getSettingMock.mockResolvedValue(false)
    await service.startUpdateService()
    // The failure is absorbed: the service still reached the preference read.
    expect(getSettingMock).toHaveBeenCalled()
  })

  it('checks metadata at startup and every six hours without downloading', async () => {
    await service.startUpdateService()
    expect(checkVersionUpdateMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(SIX_HOURS_MS)
    expect(checkVersionUpdateMock).toHaveBeenCalledTimes(2)
    expect(bridgeState.downloadUpdate).not.toHaveBeenCalled()
    expect(bridgeState.installDownloadedUpdate).not.toHaveBeenCalled()
  })

  it('does not schedule automatic checks when autoCheckUpdate is false', async () => {
    getSettingMock.mockResolvedValue(false)
    await service.startUpdateService()
    expect(checkVersionUpdateMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(SIX_HOURS_MS * 2)
    expect(checkVersionUpdateMock).not.toHaveBeenCalled()
    expect(bridgeState.downloadUpdate).not.toHaveBeenCalled()
  })

  it('never persists a pending update package', async () => {
    checkVersionUpdateMock.mockResolvedValue(AVAILABLE)
    await service.startUpdateService()
    await vi.advanceTimersByTimeAsync(SIX_HOURS_MS)
    // The only setting the service may write is the user's own preference.
    for (const call of setSettingMock.mock.calls) {
      expect(call[0]).toBe('autoCheckUpdate')
    }
  })
})

describe('setAutomaticUpdateChecksEnabled', () => {
  it('disabling persists false and clears the timer', async () => {
    await service.startUpdateService()
    expect(checkVersionUpdateMock).toHaveBeenCalledTimes(1)
    await service.setAutomaticUpdateChecksEnabled(false)
    expect(setSettingMock).toHaveBeenCalledWith('autoCheckUpdate', false)
    await vi.advanceTimersByTimeAsync(SIX_HOURS_MS * 3)
    expect(checkVersionUpdateMock).toHaveBeenCalledTimes(1)
  })

  it('enabling persists true, checks immediately, and starts exactly one timer', async () => {
    getSettingMock.mockResolvedValue(false)
    await service.startUpdateService()
    expect(checkVersionUpdateMock).not.toHaveBeenCalled()
    await service.setAutomaticUpdateChecksEnabled(true)
    expect(setSettingMock).toHaveBeenCalledWith('autoCheckUpdate', true)
    expect(checkVersionUpdateMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(SIX_HOURS_MS)
    expect(checkVersionUpdateMock).toHaveBeenCalledTimes(2)
    // Re-enabling must not stack a second timer: one immediate check now, and each
    // six-hour window advances the count by exactly one afterwards.
    await service.setAutomaticUpdateChecksEnabled(true)
    expect(checkVersionUpdateMock).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(SIX_HOURS_MS)
    expect(checkVersionUpdateMock).toHaveBeenCalledTimes(4)
  })
})

describe('manual checks', () => {
  it('work when automatic checks are disabled', async () => {
    getSettingMock.mockResolvedValue(false)
    await service.startUpdateService()
    const info = await service.checkForUpdateNow()
    expect(checkVersionUpdateMock).toHaveBeenCalledTimes(1)
    expect(info?.hasUpdate).toBe(false)
  })

  it('are deduplicated while one is already running', async () => {
    let resolveCheck: (value: VersionInfo) => void = () => {}
    checkVersionUpdateMock.mockImplementation(
      () => new Promise<VersionInfo>((resolve) => { resolveCheck = resolve }),
    )
    const first = service.checkForUpdateNow()
    const second = service.checkForUpdateNow()
    resolveCheck(AVAILABLE)
    await Promise.all([first, second])
    expect(checkVersionUpdateMock).toHaveBeenCalledTimes(1)
  })

  it('are skipped while an explicit install is in flight, so metadata stays frozen', async () => {
    checkVersionUpdateMock.mockResolvedValue(AVAILABLE)
    await service.checkForUpdateNow()
    let resolveDownload: () => void = () => {}
    bridgeState.downloadUpdate.mockImplementation(
      () => new Promise<void>((resolve) => { resolveDownload = resolve }),
    )
    const installing = service.downloadAndInstallUpdate()
    await service.checkForUpdateNow()
    expect(checkVersionUpdateMock).toHaveBeenCalledTimes(1)
    resolveDownload()
    await installing
  })

  it('keep metadata frozen when a check that was already running resolves mid-install', async () => {
    checkVersionUpdateMock.mockResolvedValueOnce(AVAILABLE)
    await service.checkForUpdateNow()

    // A slow manual check is in flight while the user starts the install.
    let resolveStaleCheck: (value: VersionInfo) => void = () => {}
    checkVersionUpdateMock.mockImplementation(
      () => new Promise<VersionInfo>((resolve) => { resolveStaleCheck = resolve }),
    )
    const staleCheck = service.checkForUpdateNow()

    let resolveDownload: () => void = () => {}
    bridgeState.downloadUpdate.mockImplementation(
      () => new Promise<void>((resolve) => { resolveDownload = resolve }),
    )
    const installing = service.downloadAndInstallUpdate()

    // The stale check finishes during the download: its result must not replace the
    // metadata the install is acting on.
    resolveStaleCheck({ ...AVAILABLE, latestVersion: '0.2.3', downloadUrl: 'https://github.com/catgirl3d/SayIt/releases/download/v0.2.3/SayIt_0.2.3_x64-setup.exe' })
    await staleCheck
    expect(service.getAutoUpdateState().versionInfo?.latestVersion).toBe('0.2.2')

    resolveDownload()
    await installing
    expect(bridgeState.installDownloadedUpdate).toHaveBeenCalledWith('0.2.2', AVAILABLE.sha512)
  })

  it('discards a check that resolves after a failed install returned the phase to idle', async () => {
    checkVersionUpdateMock.mockResolvedValueOnce(AVAILABLE)
    await service.checkForUpdateNow()

    // A slow check is in flight when the user starts an install.
    let resolveStaleCheck: (value: VersionInfo) => void = () => {}
    checkVersionUpdateMock.mockImplementation(
      () => new Promise<VersionInfo>((resolve) => { resolveStaleCheck = resolve }),
    )
    const staleCheck = service.checkForUpdateNow()

    // The install fails and the phase returns to idle — the freeze must survive that,
    // or a stale result would slip through a phase-only check.
    bridgeState.downloadUpdate.mockRejectedValue(new Error('network down'))
    await service.downloadAndInstallUpdate()
    expect(service.getAutoUpdateState().phase).toBe('idle')

    resolveStaleCheck({ ...AVAILABLE, latestVersion: '0.2.3' })
    await staleCheck
    expect(service.getAutoUpdateState().versionInfo?.latestVersion).toBe('0.2.2')
  })
})

describe('downloadAndInstallUpdate', () => {
  it('downloads and installs the same validated version and hash', async () => {
    checkVersionUpdateMock.mockResolvedValue(AVAILABLE)
    await service.checkForUpdateNow()
    await service.downloadAndInstallUpdate()
    expect(bridgeState.downloadUpdate).toHaveBeenCalledWith(
      AVAILABLE.downloadUrl,
      '0.2.2',
      AVAILABLE.sha512,
    )
    expect(bridgeState.installDownloadedUpdate).toHaveBeenCalledWith('0.2.2', AVAILABLE.sha512)
    expect(service.getAutoUpdateState().phase).toBe('installing')
  })

  it('refuses to act without validated metadata', async () => {
    await service.startUpdateService() // up-to-date manifest: nothing available
    await service.downloadAndInstallUpdate()
    expect(bridgeState.downloadUpdate).not.toHaveBeenCalled()
    expect(bridgeState.installDownloadedUpdate).not.toHaveBeenCalled()
  })

  it('on download failure keeps the update retryable and never installs', async () => {
    checkVersionUpdateMock.mockResolvedValue(AVAILABLE)
    await service.checkForUpdateNow()
    bridgeState.downloadUpdate.mockRejectedValue(new Error('network down'))
    await service.downloadAndInstallUpdate()
    expect(bridgeState.installDownloadedUpdate).not.toHaveBeenCalled()
    const state = service.getAutoUpdateState()
    expect(state.phase).toBe('idle')
    expect(state.error).toContain('network down')
    expect(service.hasAvailableUpdate()).toBe(true)
  })

  it('deduplicates repeated install actions', async () => {
    checkVersionUpdateMock.mockResolvedValue(AVAILABLE)
    await service.checkForUpdateNow()
    let resolveDownload: () => void = () => {}
    bridgeState.downloadUpdate.mockImplementation(
      () => new Promise<void>((resolve) => { resolveDownload = resolve }),
    )
    const first = service.downloadAndInstallUpdate()
    const second = service.downloadAndInstallUpdate()
    resolveDownload()
    await Promise.all([first, second])
    expect(bridgeState.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(bridgeState.installDownloadedUpdate).toHaveBeenCalledTimes(1)
  })

  it('does not persist anything about the package', async () => {
    checkVersionUpdateMock.mockResolvedValue(AVAILABLE)
    await service.checkForUpdateNow()
    await service.downloadAndInstallUpdate()
    expect(setSettingMock).not.toHaveBeenCalled()
  })
})

describe('hasAvailableUpdate', () => {
  it('reports availability from metadata, not from a downloaded package', async () => {
    expect(service.hasAvailableUpdate()).toBe(false)
    checkVersionUpdateMock.mockResolvedValue(AVAILABLE)
    await service.checkForUpdateNow()
    expect(service.hasAvailableUpdate()).toBe(true)
  })
})
