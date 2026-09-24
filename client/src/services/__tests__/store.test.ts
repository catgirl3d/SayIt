import { beforeEach, describe, expect, it, vi } from 'vitest'

const bridge = vi.hoisted(() => ({
  recordStatsDelta: vi.fn(),
  storeGet: vi.fn(),
  storeSet: vi.fn(),
}))

vi.mock('../bridge', () => bridge)

import { clearStats, estimateTypingTimeSec, recordStats } from '../store'

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

describe('clearStats', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('resets only the aggregate usage counters', async () => {
    await clearStats()

    expect(bridge.storeSet).toHaveBeenCalledTimes(1)
    expect(bridge.storeSet).toHaveBeenCalledWith('stats', { totalDurationSec: 0, totalChars: 0 })
    expect(bridge.storeGet).not.toHaveBeenCalled()
    expect(bridge.recordStatsDelta).not.toHaveBeenCalled()
  })
})

describe('estimateTypingTimeSec', () => {
  it('estimates equivalent typing duration at 50 words per minute', () => {
    expect(estimateTypingTimeSec(370)).toBe(89)
    expect(estimateTypingTimeSec(115)).toBe(28)
  })
})
