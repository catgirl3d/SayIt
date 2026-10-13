import { describe, expect, it } from 'vitest'
import { EMPTY_USAGE_SUMMARY } from '@/services/store'
import { userStatsFromUsageSummary } from '../store'
import { buildDynamicIdentityPrompt, summarizeDomainScenes } from '../userStats'

describe('userStatsFromUsageSummary', () => {
  it('derives the personalization profile from attributed usage only', () => {
    // 700 of the 2500 chars sit in the undated legacy remainder row, which has
    // no app. Counting them in totalWords would dilute every scene ratio and
    // could push a user under the identity prompt's 0.3 threshold.
    const stats = userStatsFromUsageSummary({
      ...EMPTY_USAGE_SUMMARY,
      takes: 60,
      totalChars: 2500,
      apps: [
        { key: 'Code.exe', takes: 30, chars: 1500 },
        { key: 'Telegram.exe', takes: 5, chars: 300 },
        { key: 'legacy-only.exe', takes: 0, chars: 0 },
      ],
      firstUsedAt: 1000,
      lastUsedAt: 2000,
    })

    expect(stats).toEqual({
      totalWords: 1800,
      totalSessions: 60,
      domainWords: { 'Code.exe': 1500, 'Telegram.exe': 300 },
      appUsageCount: { 'Code.exe': 30, 'Telegram.exe': 5 },
      firstUsedAt: 1000,
      lastUsedAt: 2000,
    })
    expect(summarizeDomainScenes(stats, 1)[0]?.id).toBe('development')
    expect(buildDynamicIdentityPrompt(stats)).toContain('software development background')
  })

  it('leaves the dates undefined when the log has none', () => {
    const stats = userStatsFromUsageSummary(EMPTY_USAGE_SUMMARY)
    expect(stats.firstUsedAt).toBeUndefined()
    expect(stats.lastUsedAt).toBeUndefined()
  })
})
