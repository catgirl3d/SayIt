import { api } from './client'
import type { UsageEventInput, UsageSummary } from '@/types/usage'

export interface Stats {
  totalDurationSec: number
  totalChars: number
}

/** Initial state for consumers; treat as read-only. */
export const EMPTY_USAGE_SUMMARY: UsageSummary = {
  takes: 0,
  totalChars: 0,
  totalDurationSec: 0,
  datedTakes: 0,
  datedChars: 0,
  maxDurationSec: 0,
  activeDays: 0,
  hourBuckets: new Array(24).fill(0),
  apps: [],
  workModes: [],
  promptPresets: [],
  firstUsedAt: null,
  lastUsedAt: null,
}

/**
 * The all-time summary is shared between the recorder (personalization
 * profile refresh), the home totals, and the usage page's all-time range,
 * all of which refresh on the same events, and every native call aggregates
 * the whole usage log. Only the all-time key is cached: range reads carry a
 * fresh cutoff each time and must stay live. Every write to the log
 * (`recordUsage`, `clearStats`) invalidates the entry.
 */
let allTimeUsageSummary: Promise<UsageSummary> | null = null

/** `sinceMs: null` covers all time, including the undated legacy baseline. */
export async function getUsageSummary(sinceMs: number | null): Promise<UsageSummary> {
  if (sinceMs !== null) return api().usageSummary(sinceMs)
  allTimeUsageSummary ??= api()
    .usageSummary(null)
    .catch((error) => {
      // A failed read is not a summary: drop the entry so the next caller retries.
      allTimeUsageSummary = null
      throw error
    })
  return allTimeUsageSummary
}

/** All-time totals for the home screen. */
export async function getStats(): Promise<Stats> {
  // Fail loud: Home must not present an unavailable read as zero totals.
  const summary = await getUsageSummary(null)
  return { totalDurationSec: summary.totalDurationSec, totalChars: summary.totalChars }
}

export async function recordUsage(event: UsageEventInput): Promise<void> {
  await api().usageRecord(event)
  allTimeUsageSummary = null
}

/** Clears every usage statistic (both pages and the personalization profile); history is untouched. */
export async function clearStats(): Promise<void> {
  await api().usageClear()
  allTimeUsageSummary = null
}

const TYPING_WORDS_PER_MINUTE = 50
const STANDARD_TYPING_CHARS_PER_WORD = 5

export function estimateTypingTimeSec(charCount: number): number {
  return Math.round((charCount * 60) / (TYPING_WORDS_PER_MINUTE * STANDARD_TYPING_CHARS_PER_WORD))
}
