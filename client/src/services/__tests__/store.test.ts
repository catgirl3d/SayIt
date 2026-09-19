import { beforeEach, describe, expect, it, vi } from 'vitest'

const bridge = vi.hoisted(() => ({
  recordStatsDelta: vi.fn(),
  storeGet: vi.fn(),
  storeSet: vi.fn(),
}))

vi.mock('../bridge', () => bridge)

import { recordStats } from '../store'

describe('recordStats', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('delegates the increment to the atomic native command', async () => {
    const committed = { totalDurationSec: 12.5, totalChars: 320 }
    bridge.recordStatsDelta.mockResolvedValue(committed)

    await expect(recordStats(40, 2.5)).resolves.toEqual(committed)

    expect(bridge.recordStatsDelta).toHaveBeenCalledWith(40, 2.5)
    expect(bridge.storeGet).not.toHaveBeenCalled()
    expect(bridge.storeSet).not.toHaveBeenCalled()
  })
})
