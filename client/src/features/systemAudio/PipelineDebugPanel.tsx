import { useEffect, useState, useSyncExternalStore } from 'react'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import CopyButton from '@/components/CopyButton'
import { Select, type SelectOption } from '@/components/ui/select'
import { useT } from '@/i18n/useT'
import {
  clearPipelineTrace,
  getPipelineSnapshot,
  subscribe,
  summarizeByEngine,
  type PipelineRun,
  type PipelineRunStatus,
} from '@/services/pipelineTrace'

export type PipelineStatusFilter = 'all' | 'ok' | 'problems' | 'cancelled'

export interface PipelineFilters {
  mode: string
  status: PipelineStatusFilter
}

const PROBLEM_STATUSES: readonly PipelineRunStatus[] = ['failed', 'rejected', 'timeout', 'empty']

export function filterRuns(runs: readonly PipelineRun[], filters: PipelineFilters): PipelineRun[] {
  return runs.filter((run) => {
    if (filters.mode !== 'all' && run.mode !== filters.mode) return false
    if (filters.status === 'ok') return run.status === 'ok'
    if (filters.status === 'cancelled') return run.status === 'cancelled'
    if (filters.status === 'problems') return PROBLEM_STATUSES.includes(run.status)
    return true
  })
}

function formatTime(time: number) {
  const date = new Date(time)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function formatMs(value: number | null) {
  return value === null ? '-' : String(Math.round(value))
}

function tsvRow(values: Array<string | number>) {
  return values.map((value) => String(value).replace(/[\t\r\n]+/g, ' ')).join('\t')
}

export function buildPipelineTsv(summary: ReturnType<typeof summarizeByEngine>, runs: readonly PipelineRun[]): string {
  const summaryHeader = [
    'engine/model', 'OK / total runs', 'avg speech ms', 'avg ASR ms', 'ASR p90 ms', 'ASR max ms',
    'avg LLM ms', 'avg latency ms', 'latency p90 ms', 'latency max ms',
  ]
  const runHeader = [
    'time', 'mode', 'speech ms', 'queue ms', 'ASR ms', 'LLM ms', 'overlay ms', 'latency ms', 'status', 'ASR / caption chars',
  ]
  return [
    tsvRow(summaryHeader),
    ...summary.map((row) => tsvRow([
      `${row.mode} · ${row.engine} / ${row.model}`,
      `${row.okCount} / ${row.totalCount}`,
      row.avgSpeechMs,
      row.avgAsrMs,
      row.asrP90Ms,
      row.asrMaxMs,
      row.avgLlmMs,
      row.avgLatencyMs,
      row.latencyP90Ms,
      row.latencyMaxMs,
    ])),
    '',
    tsvRow(runHeader),
    ...runs.map((run) => tsvRow([
      formatTime(run.startedAt),
      run.mode,
      formatMs(run.speechMs),
      formatMs(run.queueMs),
      formatMs(run.asrMs),
      formatMs(run.llmMs),
      formatMs(run.overlayMs),
      formatMs(run.latencyMs),
      run.status,
      `${run.asrChars} / ${run.captionChars}`,
    ])),
  ].join('\n')
}

function formatMode(mode: string, t: ReturnType<typeof useT>) {
  if (mode === 'local') return t('mode.local')
  if (mode === 'cloud_api') return t('mode.cloudApi')
  if (mode === 'server') return t('mode.server')
  return mode
}

export default function PipelineDebugPanel() {
  const t = useT()
  const snapshot = useSyncExternalStore(subscribe, getPipelineSnapshot)
  const [filters, setFilters] = useState<PipelineFilters>({ mode: 'all', status: 'all' })
  const [now, setNow] = useState(() => Date.now())
  const isTimedStage = snapshot.activity.phase === 'asr' || snapshot.activity.phase === 'translation'

  useEffect(() => {
    if (!isTimedStage) return
    const interval = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(interval)
  }, [isTimedStage])

  const filteredRuns = filterRuns(snapshot.runs, filters)
  const summary = summarizeByEngine(filteredRuns)
  const recentRuns = [...filteredRuns]
    .sort((left, right) => right.startedAt - left.startedAt || right.id - left.id)
  const modes = [...new Set(snapshot.runs.map((run) => run.mode))]
  const modeOptions: SelectOption[] = [
    { value: 'all', label: t('systemAudio.debug.filterAll') },
    ...modes.map((mode) => ({ value: mode, label: formatMode(mode, t) })),
  ]
  const statusOptions: SelectOption[] = [
    { value: 'all', label: t('systemAudio.debug.filterAll') },
    { value: 'ok', label: t('systemAudio.debug.status.ok') },
    { value: 'problems', label: t('systemAudio.debug.filterProblems') },
    { value: 'cancelled', label: t('systemAudio.debug.status.cancelled') },
  ]
  const stageElapsedMs = snapshot.activity.stageStartedAt === null
    ? null
    : Math.max(0, now - snapshot.activity.stageStartedAt)
  const counters = [
    { label: t('systemAudio.debug.frames'), value: String(snapshot.counters.frames) },
    { label: t('systemAudio.debug.frameKb'), value: (snapshot.counters.frameBytes / 1024).toFixed(1) },
    { label: t('systemAudio.debug.discontinuities'), value: String(snapshot.counters.discontinuities) },
    { label: t('systemAudio.debug.segments'), value: String(snapshot.counters.segments) },
    { label: t('systemAudio.debug.queueDepth'), value: String(snapshot.counters.queueDepth) },
    { label: t('systemAudio.debug.completed'), value: String(snapshot.counters.completed) },
    { label: t('systemAudio.debug.failed'), value: String(snapshot.counters.failed) },
  ]

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">{t('systemAudio.debug.title')}</h2>
          <div className="flex items-center gap-1">
            <CopyButton text={buildPipelineTsv(summary, recentRuns)} />
            <Button onClick={clearPipelineTrace} variant="outline" size="sm" className="h-7 gap-1 px-2 text-xs">
              <Trash2 className="h-3 w-3" /> {t('systemAudio.debug.clear')}
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {counters.map(({ label, value }) => (
            <div key={label} className="rounded-md bg-muted px-2 py-1.5">
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className="font-mono text-sm tabular-nums">{value}</div>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div className="rounded-md bg-muted px-2 py-1.5">
            <div className="text-xs text-muted-foreground">{t('systemAudio.debug.phase')}</div>
            <div className="font-mono text-sm tabular-nums">{t(`systemAudio.debug.phase.${snapshot.activity.phase}`)}</div>
          </div>
          {isTimedStage && stageElapsedMs !== null && (
            <div className="rounded-md bg-muted px-2 py-1.5">
              <div className="text-xs text-muted-foreground">{t('systemAudio.debug.stageElapsed')}</div>
              <div className="font-mono text-sm tabular-nums">{formatMs(stageElapsedMs)}</div>
            </div>
          )}
          {snapshot.activity.phase === 'speech' && (
            <div className="rounded-md bg-muted px-2 py-1.5">
              <div className="text-xs text-muted-foreground">{t('systemAudio.debug.segmentDuration')}</div>
              <div className="font-mono text-sm tabular-nums">{formatMs(snapshot.activity.segmentMs)}</div>
            </div>
          )}
          <div className="rounded-md bg-muted px-2 py-1.5">
            <div className="text-xs text-muted-foreground">{t('systemAudio.debug.queueDepth')}</div>
            <div className="font-mono text-sm tabular-nums">{snapshot.counters.queueDepth}</div>
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label id="pipeline-mode-filter-label" className="text-xs text-muted-foreground">{t('systemAudio.debug.mode')}</label>
          <Select
            value={filters.mode}
            onChange={(mode) => setFilters((current) => ({ ...current, mode }))}
            options={modeOptions}
            labelledBy="pipeline-mode-filter-label"
            className="sm:w-44"
          />
          <label id="pipeline-status-filter-label" className="text-xs text-muted-foreground sm:ml-2">{t('systemAudio.debug.status')}</label>
          <Select
            value={filters.status}
            onChange={(status) => setFilters((current) => ({ ...current, status: status as PipelineStatusFilter }))}
            options={statusOptions}
            labelledBy="pipeline-status-filter-label"
            className="sm:w-44"
          />
        </div>

        <section className="space-y-2">
          <h3 className="text-xs font-semibold">{t('systemAudio.debug.byEngine')}</h3>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-left text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="px-2 py-1 font-medium">{t('systemAudio.debug.engineModel')}</th>
                  <th className="px-2 py-1 font-medium">{t('systemAudio.debug.runs')}</th>
                  <th className="px-2 py-1 font-medium">{t('systemAudio.debug.avgSpeech')}</th>
                  <th className="px-2 py-1 font-medium">{t('systemAudio.debug.avgAsr')}</th>
                  <th className="px-2 py-1 font-medium">{t('systemAudio.debug.asrP90')}</th>
                  <th className="px-2 py-1 font-medium">{t('systemAudio.debug.asrMax')}</th>
                  <th className="px-2 py-1 font-medium">{t('systemAudio.debug.avgLlm')}</th>
                  <th className="px-2 py-1 font-medium">{t('systemAudio.debug.avgLatency')}</th>
                  <th className="px-2 py-1 font-medium">{t('systemAudio.debug.latencyP90')}</th>
                  <th className="px-2 py-1 font-medium">{t('systemAudio.debug.latencyMax')}</th>
                </tr>
              </thead>
              <tbody>
                {summary.length === 0 ? (
                  <tr><td colSpan={10} className="px-2 py-2 text-muted-foreground">{t('systemAudio.debug.empty')}</td></tr>
                ) : summary.map((row) => (
                  <tr key={row.key} className="border-t">
                    <td className="px-2 py-1.5">{formatMode(row.mode, t)} · {row.engine} / {row.model}</td>
                    <td className="px-2 py-1.5 font-mono tabular-nums">{row.okCount} / {row.totalCount}</td>
                    <td className="px-2 py-1.5 font-mono tabular-nums">{row.avgSpeechMs}</td>
                    <td className="px-2 py-1.5 font-mono tabular-nums">{row.avgAsrMs}</td>
                    <td className="px-2 py-1.5 font-mono tabular-nums">{row.asrP90Ms}</td>
                    <td className="px-2 py-1.5 font-mono tabular-nums">{row.asrMaxMs}</td>
                    <td className="px-2 py-1.5 font-mono tabular-nums">{row.avgLlmMs}</td>
                    <td className="px-2 py-1.5 font-mono tabular-nums">{row.avgLatencyMs}</td>
                    <td className="px-2 py-1.5 font-mono tabular-nums">{row.latencyP90Ms}</td>
                    <td className="px-2 py-1.5 font-mono tabular-nums">{row.latencyMaxMs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="space-y-2">
          <h3 className="text-xs font-semibold">{t('systemAudio.debug.runsList')}</h3>
          <div className="max-h-80 overflow-y-auto overflow-x-auto">
            <table className="w-full min-w-[940px] text-left text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="px-2 py-1 font-medium">{t('systemAudio.debug.time')}</th>
                  <th className="px-2 py-1 font-medium">{t('systemAudio.debug.mode')}</th>
                  <th className="px-2 py-1 font-medium">{t('systemAudio.debug.speech')}</th>
                  <th className="px-2 py-1 font-medium">{t('systemAudio.debug.queue')}</th>
                  <th className="px-2 py-1 font-medium">{t('systemAudio.debug.asr')}</th>
                  <th className="px-2 py-1 font-medium">{t('systemAudio.debug.llm')}</th>
                  <th className="px-2 py-1 font-medium">{t('systemAudio.debug.overlay')}</th>
                  <th className="px-2 py-1 font-medium">{t('systemAudio.debug.latency')}</th>
                  <th className="px-2 py-1 font-medium">{t('systemAudio.debug.status')}</th>
                  <th className="px-2 py-1 font-medium">{t('systemAudio.debug.chars')}</th>
                </tr>
              </thead>
              <tbody>
                {recentRuns.length === 0 ? (
                  <tr><td colSpan={10} className="px-2 py-2 text-muted-foreground">{t('systemAudio.debug.empty')}</td></tr>
                ) : recentRuns.map((run) => (
                  <tr key={run.id} className="border-t">
                    <td className="px-2 py-1.5 font-mono tabular-nums">{formatTime(run.startedAt)}</td>
                    <td className="px-2 py-1.5">{formatMode(run.mode, t)}</td>
                    <td className="px-2 py-1.5 font-mono tabular-nums">{formatMs(run.speechMs)}</td>
                    <td className={`px-2 py-1.5 font-mono tabular-nums ${run.queueMs !== null && run.queueMs > 1000 ? 'text-amber-600 dark:text-amber-300' : ''}`}>{formatMs(run.queueMs)}</td>
                    <td className="px-2 py-1.5 font-mono tabular-nums">{formatMs(run.asrMs)}</td>
                    <td className="px-2 py-1.5 font-mono tabular-nums">{formatMs(run.llmMs)}</td>
                    <td className="px-2 py-1.5 font-mono tabular-nums">{formatMs(run.overlayMs)}</td>
                    <td className={`px-2 py-1.5 font-mono tabular-nums ${run.latencyMs !== null && run.latencyMs > 4000 ? 'text-destructive' : ''}`}>{formatMs(run.latencyMs)}</td>
                    <td className="px-2 py-1.5">{t(`systemAudio.debug.status.${run.status}`)}</td>
                    <td className="px-2 py-1.5 font-mono tabular-nums">{run.asrChars} / {run.captionChars}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </CardContent>
    </Card>
  )
}
