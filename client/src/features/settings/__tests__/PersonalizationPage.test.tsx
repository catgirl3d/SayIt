// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '@/i18n'
import { EMPTY_USAGE_SUMMARY, type PromptPreset } from '@/services/store'
import type { UsageSummary } from '@/types/usage'

const mocks = vi.hoisted(() => ({
  getUsageSummary: vi.fn(),
  getPromptPresets: vi.fn(),
  statsListeners: [] as Array<(event: unknown) => void>,
  unlistenStats: vi.fn(),
}))

vi.mock('@/services/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/store')>()
  return {
    ...actual,
    getUsageSummary: (...args: unknown[]) => mocks.getUsageSummary(...args),
    getPromptPresets: (...args: unknown[]) => mocks.getPromptPresets(...args),
  }
})

vi.mock('@/services/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/bridge')>()
  return {
    ...actual,
    listen: (event: string, handler: (event: unknown) => void) => {
      if (event === 'stats-updated') mocks.statsListeners.push(handler)
      return Promise.resolve(mocks.unlistenStats)
    },
  }
})

import PersonalizationPage from '../PersonalizationPage'

function summary(overrides: Partial<UsageSummary>): UsageSummary {
  return { ...EMPTY_USAGE_SUMMARY, hourBuckets: new Array(24).fill(0), ...overrides }
}

function emitStatsUpdated() {
  for (const handler of mocks.statsListeners) handler({ event: 'stats-updated', payload: undefined })
}

describe('usage page', () => {
  beforeEach(() => {
    mocks.getUsageSummary.mockReset().mockResolvedValue(summary({}))
    mocks.getPromptPresets.mockReset().mockResolvedValue([])
    mocks.statsListeners.length = 0
    mocks.unlistenStats.mockReset()
  })

  it('shows all-time totals from the usage log even without dated events', async () => {
    mocks.getUsageSummary.mockResolvedValue(
      summary({ takes: 933, totalChars: 25000, totalDurationSec: 7200, firstUsedAt: Date.now() - 52 * 86400000 }),
    )

    render(<PersonalizationPage />)

    await waitFor(() => expect(screen.getByText((25000).toLocaleString())).toBeTruthy())
    expect(mocks.getUsageSummary).toHaveBeenCalledWith(null)
    expect(screen.getByText(t('stats.takes'))).toBeTruthy()
    expect(screen.getByText('933')).toBeTruthy()
    expect(screen.getByText(t('stats.durationHours', { hour: 2, min: 0 }))).toBeTruthy()
    expect(screen.queryByText(t('stats.timeOfDay'))).toBeNull()
  })

  it('asks for the period from local midnight and labels its breakdowns', async () => {
    const hourBuckets = new Array(24).fill(0)
    hourBuckets[9] = 2
    mocks.getUsageSummary.mockImplementation(async (sinceMs: number | null) =>
      sinceMs === null
        ? summary({})
        : summary({
            takes: 2, totalChars: 70, totalDurationSec: 30, datedTakes: 2, datedChars: 70,
            maxDurationSec: 20, activeDays: 1, hourBuckets,
            apps: [{ key: 'Code.exe', takes: 2, chars: 70 }],
            workModes: [{ key: 'cloud_api', takes: 2, chars: 70 }],
            promptPresets: [{ key: 'custom-1', takes: 2, chars: 70 }],
          }),
    )
    mocks.getPromptPresets.mockResolvedValue([{ id: 'custom-1', name: 'Letters' }] as unknown as PromptPreset[])

    render(<PersonalizationPage />)
    fireEvent.click(screen.getByText(t('range.today')))

    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    await waitFor(() => expect(mocks.getUsageSummary).toHaveBeenLastCalledWith(midnight.getTime()))
    await waitFor(() => expect(screen.getByText('Code')).toBeTruthy())
    expect(screen.getByText('Letters')).toBeTruthy()
    expect(screen.getByText(t('record.modeCloudApi'))).toBeTruthy()
    expect(screen.getByText(t('stats.timeOfDay'))).toBeTruthy()
  })

  it('refreshes the visible totals when the recorder emits stats-updated', async () => {
    mocks.getUsageSummary.mockResolvedValue(summary({ takes: 3, totalChars: 120 }))
    render(<PersonalizationPage />)
    await waitFor(() => expect(screen.getByText('3')).toBeTruthy())

    mocks.getUsageSummary.mockResolvedValue(summary({ takes: 8, totalChars: 400 }))
    emitStatsUpdated()

    await waitFor(() => expect(screen.getByText('8')).toBeTruthy())
    expect(screen.queryByText('3')).toBeNull()
    expect(mocks.getUsageSummary).toHaveBeenLastCalledWith(null)
  })

  it('keeps the newly selected range when the older request resolves later', async () => {
    let resolveAll!: (value: UsageSummary) => void
    const staleAll = new Promise<UsageSummary>((resolve) => { resolveAll = resolve })
    const hourBuckets = new Array(24).fill(0)
    const today = summary({
      takes: 2, totalChars: 70, totalDurationSec: 30, datedTakes: 2, datedChars: 70,
      maxDurationSec: 20, activeDays: 1, hourBuckets,
    })
    mocks.getUsageSummary.mockImplementation((sinceMs: number | null) =>
      sinceMs === null ? staleAll : Promise.resolve(today))

    render(<PersonalizationPage />)
    fireEvent.click(screen.getByText(t('range.today')))
    await waitFor(() => expect(screen.getByText('2')).toBeTruthy())

    resolveAll(summary({ takes: 933, totalChars: 25000, totalDurationSec: 7200 }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(screen.queryByText('933')).toBeNull()
    expect(screen.getByText('2')).toBeTruthy()
  })

  it('lets a stats-updated refresh win over a response still in flight', async () => {
    let resolveStale!: (value: UsageSummary) => void
    const stale = new Promise<UsageSummary>((resolve) => { resolveStale = resolve })
    mocks.getUsageSummary
      .mockImplementationOnce(() => stale)
      .mockImplementation(() => Promise.resolve(summary({})))

    render(<PersonalizationPage />)
    await waitFor(() => expect(mocks.getUsageSummary).toHaveBeenCalledTimes(1))

    emitStatsUpdated()
    await waitFor(() => expect(mocks.getUsageSummary).toHaveBeenCalledTimes(2))

    resolveStale(summary({ takes: 933, totalChars: 25000 }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(screen.queryByText('933')).toBeNull()
    expect(screen.queryByText((25000).toLocaleString())).toBeNull()
  })

  it('stops listening for stats-updated when the page unmounts', async () => {
    const { unmount } = render(<PersonalizationPage />)
    await waitFor(() => expect(mocks.statsListeners.length).toBe(1))

    unmount()

    await waitFor(() => expect(mocks.unlistenStats).toHaveBeenCalledTimes(1))
  })
})
