// Usage statistics page

import { useEffect, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import {
  EMPTY_USAGE_SUMMARY,
  estimateTypingTimeSec,
  getPromptPresets,
  getUsageSummary,
  type PromptPreset,
} from '@/services/store'
import type { UsageBreakdown, UsageSummary } from '@/types/usage'
import { getLocale, t, type TranslationKey } from '@/i18n'
import { useT } from '@/i18n/useT'
import { recordedAppDisplayName, recordedPromptPresetDisplayName } from '@/i18n/displayNames'
import * as bridge from '@/services/bridge'

type TimeRange = 'today' | '7d' | '30d' | 'all'

const RANGE_OPTIONS: { value: TimeRange; labelKey: TranslationKey }[] = [
  { value: 'today', labelKey: 'range.today' },
  { value: '7d', labelKey: 'range.7d' },
  { value: '30d', labelKey: 'range.30d' },
  { value: 'all', labelKey: 'range.all' },
]

function getStartOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function getRangeCutoff(range: TimeRange): number {
  const now = new Date()
  switch (range) {
    case 'today': return getStartOfDay(now).getTime()
    case '7d': return getStartOfDay(new Date(now.getTime() - 6 * 86400000)).getTime()
    case '30d': return getStartOfDay(new Date(now.getTime() - 29 * 86400000)).getTime()
    case 'all': return 0
  }
}

function formatDuration(sec: number) {
  if (sec < 60) return t('stats.durationSeconds', { sec })
  if (sec < 3600) return t('stats.durationMinutes', { min: Math.floor(sec / 60), sec: sec % 60 })
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return t('stats.durationHours', { hour: h, min: m })
}

function formatDate(ts: number | null | undefined) {
  if (!ts) return '-'
  return new Date(ts).toLocaleDateString(getLocale(), { year: 'numeric', month: 'long', day: 'numeric' })
}

/** Whole days between two timestamps (at least 1). */
function daysBetween(a: number, b: number) {
  return Math.max(1, Math.ceil(Math.abs(b - a) / 86400000))
}

const WORK_MODE_LABEL_KEYS: Record<string, TranslationKey> = {
  server: 'record.modeServer',
  cloud_api: 'record.modeCloudApi',
  local: 'record.modeLocal',
}

interface PageStats {
  totalChars: number
  totalDurationSec: number
  takes: number
  avgCharsPerTake: number
  avgSpeed: number
  savedTimeSec: number
  maxDurationSec: number
  dailyAvgTakes: number
  dailyAvgChars: number
}

/**
 * Daily averages use dated events only: the undated baseline carried over
 * from the old counters has no days to spread across.
 */
function computePageStats(summary: UsageSummary, rangeDays: number): PageStats {
  const activeDays = Math.max(1, rangeDays > 0 ? Math.min(rangeDays, summary.activeDays || 1) : summary.activeDays || 1)
  return {
    totalChars: summary.totalChars,
    totalDurationSec: Math.round(summary.totalDurationSec),
    takes: summary.takes,
    avgCharsPerTake: summary.takes > 0 ? Math.round(summary.totalChars / summary.takes) : 0,
    avgSpeed: summary.totalDurationSec > 60 ? Math.round(summary.totalChars / (summary.totalDurationSec / 60)) : 0,
    savedTimeSec: estimateTypingTimeSec(summary.totalChars),
    maxDurationSec: Math.round(summary.maxDurationSec),
    dailyAvgTakes: Math.round((summary.datedTakes / activeDays) * 10) / 10,
    dailyAvgChars: Math.round(summary.datedChars / activeDays),
  }
}

function appDisplayName(key: string): string {
  if (key === 'unknown') return t('stats.unknown')
  return recordedAppDisplayName(key, key.replace(/\.exe$/i, ''))
}

/** Usage stores preset ids only; names come from the presets that still exist. */
function presetDisplayName(id: string, presets: PromptPreset[]): string {
  const saved = presets.find((preset) => preset.id === id)
  return recordedPromptPresetDisplayName(id, saved?.name || t('stats.unknown'))
}

/** Counts per display label, largest first; rows without takes are baseline characters only. */
function toEntries(items: UsageBreakdown[], label: (key: string) => string): [string, number][] {
  const merged = new Map<string, number>()
  for (const item of items) {
    if (item.takes <= 0) continue
    const name = label(item.key)
    merged.set(name, (merged.get(name) || 0) + item.takes)
  }
  return [...merged.entries()].sort(([, a], [, b]) => b - a)
}

/** Hour-of-day distribution bar chart. */
function HourChart({ buckets }: { buckets: number[] }) {
  const max = Math.max(...buckets, 1)
  const periods = [
    { label: t('stats.bucket.night'), sum: buckets.slice(0, 6).reduce((a, b) => a + b, 0) },
    { label: t('stats.bucket.morning'), sum: buckets.slice(6, 12).reduce((a, b) => a + b, 0) },
    { label: t('stats.bucket.afternoon'), sum: buckets.slice(12, 18).reduce((a, b) => a + b, 0) },
    { label: t('stats.bucket.evening'), sum: buckets.slice(18, 24).reduce((a, b) => a + b, 0) },
  ]
  const totalSum = periods.reduce((a, p) => a + p.sum, 0) || 1

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-[3px]" style={{ height: 64 }}>
        {buckets.map((count, hour) => (
          <div key={hour} className="group relative flex-1">
            <div
              className="w-full rounded-sm bg-primary/20 transition-colors group-hover:bg-primary/30"
              style={{ height: `${Math.max(count > 0 ? 4 : 1, (count / max) * 60)}px` }}
            />
            <div className="pointer-events-none absolute -top-7 left-1/2 -translate-x-1/2 rounded bg-foreground px-1.5 py-0.5 text-[10px] text-background opacity-0 transition-opacity group-hover:opacity-100 whitespace-nowrap">
              {t('stats.hourTooltip', { hour, count })}
            </div>
          </div>
        ))}
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground px-0.5">
        <span>0</span><span>6</span><span>12</span><span>18</span><span>24</span>
      </div>
      <div className="grid grid-cols-4 gap-2">
        {periods.map((p) => (
          <div key={p.label} className="rounded-lg bg-muted/30 px-2.5 py-2 text-center">
            <p className="text-[11px] text-muted-foreground">{p.label}</p>
            <p className="text-sm font-medium">{p.sum}</p>
            <p className="text-[10px] text-muted-foreground">{Math.round((p.sum / totalSum) * 100)}%</p>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Distribution list (uniform muted tint). */
function DistributionList({ entries }: { entries: [string, number][] }) {
  const maxCount = entries.length > 0 ? entries[0][1] : 1

  return (
    <div className="space-y-2">
      {entries.map(([label, count]) => (
        <div key={label} className="flex items-center gap-3">
          <span className="w-20 shrink-0 truncate text-sm">{label}</span>
          <div className="relative h-6 flex-1 overflow-hidden rounded-md bg-muted/20">
            <div
              className="absolute inset-y-0 left-0 rounded-md bg-primary/15"
              style={{ width: `${Math.max((count / maxCount) * 100, 3)}%` }}
            />
          </div>
          <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
            {t('stats.timesValue', { count })}
          </span>
        </div>
      ))}
    </div>
  )
}

export default function PersonalizationPage() {
  useT()
  const [range, setRange] = useState<TimeRange>('all')
  const [summary, setSummary] = useState<UsageSummary>(EMPTY_USAGE_SUMMARY)
  const [presets, setPresets] = useState<PromptPreset[]>([])
  const [reloadNonce, setReloadNonce] = useState(0)

  useEffect(() => {
    getPromptPresets()
      .then(setPresets)
      .catch((error) => console.error('[usage] Failed to load prompt presets:', error))
  }, [])

  useEffect(() => {
    let cancelled = false
    getUsageSummary(range === 'all' ? null : getRangeCutoff(range))
      .then((next) => {
        if (!cancelled) setSummary(next)
      })
      .catch((error) => console.error('[usage] Failed to load usage summary:', error))
    return () => {
      cancelled = true
    }
  }, [range, reloadNonce])

  // Live refresh: the recorder emits stats-updated after every recorded dictation and after
  // clearing statistics. The nonce re-runs the load effect for the currently selected range,
  // and its cleanup keeps an older in-flight response from overwriting the newer one.
  useEffect(() => {
    const unlisten = bridge.listen('stats-updated', () => {
      setReloadNonce((nonce) => nonce + 1)
    })
    return () => {
      unlisten.then((fn) => fn()).catch((error) => console.error('[usage] Failed to remove the stats-updated listener:', error))
    }
  }, [])

  const rangeDays = range === 'today' ? 1 : range === '7d' ? 7 : range === '30d' ? 30 : 0
  const stats = computePageStats(summary, rangeDays)
  const appUsageEntries = toEntries(summary.apps, appDisplayName)
  const workModeEntries = toEntries(summary.workModes, (key) => (WORK_MODE_LABEL_KEYS[key] ? t(WORK_MODE_LABEL_KEYS[key]) : key))
  const presetEntries = toEntries(summary.promptPresets, (id) => presetDisplayName(id, presets))

  // Days since first use
  const usageDays = summary.firstUsedAt ? daysBetween(summary.firstUsedAt, Date.now()) : 0

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">{t('stats.title')}</h1>
        <div className="mt-3 inline-flex gap-1 rounded-lg border border-border p-0.5">
          {RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setRange(opt.value)}
              className={`rounded-md px-3 py-1 text-xs transition-all ${range === opt.value
                ? 'bg-accent text-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground'
                }`}
            >
              {t(opt.labelKey)}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-5">
        {/* Core metrics, four columns */}
        <Card>
          <CardContent className="p-6">
            {/* First-use hint (All time only, part of the header) */}
            {range === 'all' && summary.firstUsedAt !== null && (
              <p className="mb-4 text-xs text-muted-foreground">
                {t('stats.sinceHint', { date: formatDate(summary.firstUsedAt), days: usageDays })}
              </p>
            )}

            <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
              <div>
                <p className="text-xs text-muted-foreground">{t('stats.totalChars')}</p>
                <p className="mt-0.5 text-xl font-semibold">{stats.totalChars.toLocaleString()}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{t('stats.takes')}</p>
                <p className="mt-0.5 text-xl font-semibold">{t('stats.recordsValue', { count: stats.takes.toLocaleString() })}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{t('stats.dictationTime')}</p>
                <p className="mt-0.5 text-xl font-semibold">{formatDuration(stats.totalDurationSec)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{t('stats.savedTime')}</p>
                <p className="mt-0.5 text-xl font-semibold">{formatDuration(stats.savedTimeSec)}</p>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-border pt-4 sm:grid-cols-4">
              <div>
                <span className="text-xs text-muted-foreground">{t('stats.avgChars')}</span>
                <p className="text-sm font-medium">{stats.avgCharsPerTake}</p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">{t('stats.avgSpeed')}</span>
                <p className="text-sm font-medium">{t('stats.speedValue', { value: stats.avgSpeed })}</p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">{t('stats.longestTake')}</span>
                <p className="text-sm font-medium">{stats.maxDurationSec > 0 ? formatDuration(stats.maxDurationSec) : '-'}</p>
              </div>
              <div>
                <span className="text-xs text-muted-foreground">{t('stats.dailyAverage')}</span>
                <p className="text-sm font-medium">{t('stats.dailyAverageValue', { records: stats.dailyAvgTakes, chars: stats.dailyAvgChars })}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Hour-of-day distribution */}
        {summary.datedTakes > 0 && (
          <Card>
            <CardContent className="p-6">
              <h2 className="mb-4 text-lg font-semibold">{t('stats.timeOfDay')}</h2>
              <HourChart buckets={summary.hourBuckets} />
            </CardContent>
          </Card>
        )}

        {/* Processing mode and prompt preset, side by side */}
        {(workModeEntries.length > 0 || presetEntries.length > 0) && (
          <div className="grid gap-5 sm:grid-cols-2">
            {workModeEntries.length > 0 && (
              <Card>
                <CardContent className="p-6">
                  <h2 className="mb-3 text-lg font-semibold">{t('stats.workMode')}</h2>
                  <DistributionList entries={workModeEntries} />
                </CardContent>
              </Card>
            )}
            {presetEntries.length > 0 && (
              <Card>
                <CardContent className="p-6">
                  <h2 className="mb-3 text-lg font-semibold">{t('stats.promptPreset')}</h2>
                  <DistributionList entries={presetEntries} />
                </CardContent>
              </Card>
            )}
          </div>
        )}

        {/* Per-app usage counts */}
        {appUsageEntries.length > 0 && (
          <Card>
            <CardContent className="p-6">
              <h2 className="mb-3 text-lg font-semibold">{t('stats.appUsage')}</h2>
              <div className="space-y-2">
                {appUsageEntries.map(([appName, count]) => {
                  const maxCount = appUsageEntries[0][1]
                  const pct = Math.max((count / maxCount) * 100, 3)
                  return (
                    <div key={appName} className="flex items-center gap-3">
                      <span className="w-28 shrink-0 truncate text-sm">{appName}</span>
                      <div className="relative h-6 flex-1 overflow-hidden rounded-md bg-muted/20">
                        <div
                          className="absolute inset-y-0 left-0 rounded-md bg-primary/15"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                        {t('stats.timesValue', { count })}
                      </span>
                    </div>
                  )
                })}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  )
}
