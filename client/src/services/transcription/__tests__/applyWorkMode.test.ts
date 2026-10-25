import { beforeEach, describe, expect, it, vi } from 'vitest'

const deps = vi.hoisted(() => ({
  stop: vi.fn(),
  getSnapshot: vi.fn(),
  setSetting: vi.fn(),
  switchProvider: vi.fn(),
  refreshRecorderSettings: vi.fn(),
  reconnectProvider: vi.fn(),
  refreshModeStatus: vi.fn(),
}))

vi.mock('@/services/systemAudio', () => ({
  systemAudioSession: { stop: deps.stop, getSnapshot: deps.getSnapshot },
}))
vi.mock('@/services/store', () => ({ setSetting: deps.setSetting }))
vi.mock('@/services/recorder', () => ({
  refreshRecorderSettings: deps.refreshRecorderSettings,
  reconnectProvider: deps.reconnectProvider,
}))
vi.mock('@/stores/modeStatus', () => ({ refreshModeStatus: deps.refreshModeStatus }))
vi.mock('../index', () => ({ switchProvider: deps.switchProvider }))

import { applyWorkMode } from '../applyWorkMode'

describe('applyWorkMode', () => {
  beforeEach(() => {
    deps.stop.mockReset().mockResolvedValue(undefined)
    deps.getSnapshot.mockReset().mockReturnValue({ state: 'idle', error: '' })
    deps.setSetting.mockReset().mockResolvedValue(undefined)
    deps.switchProvider.mockReset().mockResolvedValue(undefined)
    deps.refreshRecorderSettings.mockReset().mockResolvedValue(undefined)
    deps.reconnectProvider.mockReset()
    deps.refreshModeStatus.mockReset().mockResolvedValue(undefined)
  })

  it('throws the subtitle cleanup error and persists nothing when system audio does not stop', async () => {
    deps.getSnapshot.mockReturnValue({ state: 'error', error: 'Native subtitle cleanup failed' })

    await expect(applyWorkMode('cloud_api')).rejects.toThrow('Native subtitle cleanup failed')

    expect(deps.setSetting).not.toHaveBeenCalled()
    expect(deps.switchProvider).not.toHaveBeenCalled()
    expect(deps.refreshRecorderSettings).not.toHaveBeenCalled()
    expect(deps.reconnectProvider).not.toHaveBeenCalled()
    expect(deps.refreshModeStatus).not.toHaveBeenCalled()
  })

  it('persists the mode and refreshes the provider, recorder, and status badge', async () => {
    await applyWorkMode('local')

    expect(deps.setSetting).toHaveBeenCalledWith('workMode', 'local')
    expect(deps.switchProvider).toHaveBeenCalledWith('local')
    expect(deps.refreshRecorderSettings).toHaveBeenCalledTimes(1)
    expect(deps.reconnectProvider).toHaveBeenCalledTimes(1)
    expect(deps.refreshModeStatus).toHaveBeenCalledTimes(1)
  })
})
