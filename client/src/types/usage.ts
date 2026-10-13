/** One completed dictation, as sent to the native usage log. */
export interface UsageEventInput {
  charCount: number
  durationSec: number
  appId?: string
  workMode?: string
  promptPresetId?: string
}

export interface UsageBreakdown {
  key: string
  takes: number
  chars: number
}

/** Aggregates computed natively over a time range (see storage/usage.rs). */
export interface UsageSummary {
  takes: number
  totalChars: number
  totalDurationSec: number
  /** Dated events only; the undated legacy baseline is excluded. */
  datedTakes: number
  datedChars: number
  maxDurationSec: number
  activeDays: number
  /** Dated takes per local hour of day, 24 entries. */
  hourBuckets: number[]
  apps: UsageBreakdown[]
  workModes: UsageBreakdown[]
  promptPresets: UsageBreakdown[]
  firstUsedAt: number | null
  lastUsedAt: number | null
}
