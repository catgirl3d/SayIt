import { useSyncExternalStore } from 'react'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { useT } from '@/i18n/useT'
import {
  clearPipelineTrace,
  getPipelineSnapshot,
  subscribe,
  summarizeByEngine,
} from '@/services/pipelineTrace'

function formatTime(time: number) {
  const date = new Date(time)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function formatMs(value: number | null) {
  return value === null ? '-' : String(Math.round(value))
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
  const summary = summarizeByEngine([...snapshot.runs])
  const recentRuns = [...snapshot.runs]
    .sort((left, right) => right.startedAt - left.startedAt || right.id - left.id)
    .slice(0, 10)
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
          <Button onClick={clearPipelineTrace} variant="outline" size="sm" className="h-7 gap-1 px-2 text-xs">
            <Trash2 className="h-3 w-3" /> {t('systemAudio.debug.clear')}
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
          {counters.map(({ label, value }) => (
            <div key={label} className="rounded-md bg-muted px-2 py-1.5">
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className="font-mono text-sm tabular-nums">{value}</div>
            </div>
          ))}
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
                  <th className="px-2 py-1 font-medium">{t('systemAudio.debug.avgLlm')}</th>
                  <th className="px-2 py-1 font-medium">{t('systemAudio.debug.avgLatency')}</th>
                </tr>
              </thead>
              <tbody>
                {summary.length === 0 ? (
                  <tr><td colSpan={6} className="px-2 py-2 text-muted-foreground">{t('systemAudio.debug.empty')}</td></tr>
                ) : summary.map((row) => (
                  <tr key={row.key} className="border-t">
                    <td className="px-2 py-1.5">{formatMode(row.mode, t)} · {row.engine} / {row.model}</td>
                    <td className="px-2 py-1.5 font-mono tabular-nums">{row.count}</td>
                    <td className="px-2 py-1.5 font-mono tabular-nums">{row.avgSpeechMs}</td>
                    <td className="px-2 py-1.5 font-mono tabular-nums">{row.avgAsrMs}</td>
                    <td className="px-2 py-1.5 font-mono tabular-nums">{row.avgLlmMs}</td>
                    <td className="px-2 py-1.5 font-mono tabular-nums">{row.avgLatencyMs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="space-y-2">
          <h3 className="text-xs font-semibold">{t('systemAudio.debug.lastRuns')}</h3>
          <div className="overflow-x-auto">
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
                    <td className="px-2 py-1.5 font-mono tabular-nums">{formatMs(run.queueMs)}</td>
                    <td className="px-2 py-1.5 font-mono tabular-nums">{formatMs(run.asrMs)}</td>
                    <td className="px-2 py-1.5 font-mono tabular-nums">{formatMs(run.llmMs)}</td>
                    <td className="px-2 py-1.5 font-mono tabular-nums">{formatMs(run.overlayMs)}</td>
                    <td className="px-2 py-1.5 font-mono tabular-nums">{formatMs(run.latencyMs)}</td>
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
