import type { WorkMode } from './transcription/types'

export type PipelineRunStatus = 'ok' | 'empty' | 'rejected' | 'failed' | 'timeout' | 'cancelled'
export type PipelinePhase = 'idle' | 'listening' | 'speech' | 'asr' | 'translation'

export interface PipelineActivity {
  phase: PipelinePhase
  segmentMs: number
  stageStartedAt: number | null
}

export interface PipelineRun {
  readonly id: number
  readonly startedAt: number
  readonly mode: WorkMode | 'unknown'
  readonly speechMs: number
  readonly queueMs: number | null
  readonly asrMs: number | null
  readonly llmMs: number | null
  readonly overlayMs: number | null
  readonly latencyMs: number | null
  readonly status: PipelineRunStatus
  readonly reason?: string
  readonly asrOnly?: boolean
  readonly asrEngine?: string
  readonly asrModel?: string
  readonly aiProvider?: string
  readonly aiModel?: string
  readonly asrChars: number
  readonly captionChars: number
}

export interface PipelineSnapshot {
  readonly enabled: boolean
  readonly counters: Readonly<{
    frames: number
    frameBytes: number
    discontinuities: number
    segments: number
    completed: number
    failed: number
    queueDepth: number
  }>
  readonly activity: Readonly<PipelineActivity>
  readonly runs: readonly PipelineRun[]
}

type PipelineRunFields = Partial<Pick<PipelineRun,
  'asrMs' | 'llmMs' | 'overlayMs' | 'asrEngine' | 'asrModel' | 'aiProvider' | 'aiModel' | 'asrChars' | 'captionChars'
>>

interface ActiveRun {
  id: number
  startedAt: number
  mode: WorkMode | 'unknown'
  speechMs: number
  asrOnly?: boolean
  queueMs: number | null
}

const MAX_RUNS = 100
const counters = {
  frames: 0,
  frameBytes: 0,
  discontinuities: 0,
  segments: 0,
  completed: 0,
  failed: 0,
  queueDepth: 0,
}
const activity: PipelineActivity = {
  phase: 'idle',
  segmentMs: 0,
  stageStartedAt: null,
}
const listeners = new Set<() => void>()
const activeRuns = new Map<number, ActiveRun>()
let enabled = false
let nextRunId = 0
let runs: PipelineRun[] = []

function createSnapshot(): PipelineSnapshot {
  return Object.freeze({
    enabled,
    counters: Object.freeze({ ...counters }),
    activity: Object.freeze({ ...activity }),
    runs: Object.freeze(runs.map((run) => Object.freeze({ ...run }))),
  })
}

let snapshot = createSnapshot()

function publishSnapshot() {
  snapshot = createSnapshot()
  listeners.forEach((listener) => listener())
}

export function setPipelineDebugEnabled(value: boolean) {
  if (enabled === value) return
  enabled = value
  if (!enabled) activeRuns.clear()
  publishSnapshot()
}

export function isPipelineDebugEnabled() {
  return enabled
}

export function beginRun(input: { mode: WorkMode | 'unknown'; speechMs: number; asrOnly?: boolean }): number | null {
  if (!enabled) return null
  const id = ++nextRunId
  activeRuns.set(id, {
    id,
    startedAt: Date.now(),
    mode: input.mode,
    speechMs: input.speechMs,
    asrOnly: input.asrOnly,
    queueMs: null,
  })
  counters.segments++
  publishSnapshot()
  return id
}

export function markQueued(runId: number | null) {
  if (!enabled || runId === null) return
  const run = activeRuns.get(runId)
  if (!run || run.queueMs !== null) return
  run.queueMs = Math.max(0, Date.now() - run.startedAt)
  publishSnapshot()
}

export function finishRun(runId: number | null, fields: PipelineRunFields) {
  if (!enabled || runId === null) return
  const active = activeRuns.get(runId)
  if (!active) return
  activeRuns.delete(runId)
  runs.push({
    ...active,
    asrMs: fields.asrMs ?? null,
    llmMs: fields.llmMs ?? null,
    overlayMs: fields.overlayMs ?? null,
    latencyMs: Math.max(0, Date.now() - active.startedAt),
    status: 'ok',
    asrEngine: fields.asrEngine,
    asrModel: fields.asrModel,
    aiProvider: fields.aiProvider,
    aiModel: fields.aiModel,
    asrChars: fields.asrChars ?? 0,
    captionChars: fields.captionChars ?? 0,
  })
  if (runs.length > MAX_RUNS) runs = runs.slice(-MAX_RUNS)
  counters.completed++
  publishSnapshot()
}

export function failRun(runId: number | null, status: PipelineRunStatus, reason?: string) {
  if (!enabled || runId === null || status === 'ok') return
  const active = activeRuns.get(runId)
  if (!active) return
  activeRuns.delete(runId)
  runs.push({
    ...active,
    asrMs: null,
    llmMs: null,
    overlayMs: null,
    latencyMs: Math.max(0, Date.now() - active.startedAt),
    status,
    reason,
    asrChars: 0,
    captionChars: 0,
  })
  if (runs.length > MAX_RUNS) runs = runs.slice(-MAX_RUNS)
  if (status !== 'cancelled') counters.failed++
  publishSnapshot()
}

export function countFrame(bytes: number, update?: Partial<Pick<PipelineActivity, 'phase' | 'segmentMs'>>) {
  if (!enabled) return
  counters.frames++
  counters.frameBytes += bytes
  if (update?.phase !== undefined) activity.phase = update.phase
  if (update?.segmentMs !== undefined) activity.segmentMs = update.segmentMs
  publishSnapshot()
}

export function setPipelineActivity(update: Partial<PipelineActivity>) {
  if (!enabled) return
  Object.assign(activity, update)
  publishSnapshot()
}

export function countDiscontinuity() {
  if (!enabled) return
  counters.discontinuities++
  publishSnapshot()
}

export function setQueueDepth(depth: number) {
  if (!enabled) return
  const nextDepth = Math.max(0, depth)
  if (counters.queueDepth === nextDepth) return
  counters.queueDepth = nextDepth
  publishSnapshot()
}

export function clearPipelineTrace() {
  activeRuns.clear()
  Object.assign(counters, {
    frames: 0,
    frameBytes: 0,
    discontinuities: 0,
    segments: 0,
    completed: 0,
    failed: 0,
    queueDepth: 0,
  })
  Object.assign(activity, {
    phase: 'idle',
    segmentMs: 0,
    stageStartedAt: null,
  })
  runs = []
  publishSnapshot()
}

export function getPipelineSnapshot() {
  return snapshot
}

export function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function percentile(values: number[], p: number): number {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right)
  if (!sorted.length) return 0
  const rank = Math.min(1, Math.max(0, p))
  const index = Math.max(0, Math.ceil(rank * sorted.length) - 1)
  return Math.round(sorted[index])
}

export function summarizeByEngine(inputRuns: PipelineRun[]): Array<{
  key: string
  mode: string
  asrOnly: boolean
  engine: string
  model: string
  okCount: number
  totalCount: number
  avgSpeechMs: number
  avgAsrMs: number
  asrP90Ms: number
  asrMaxMs: number
  avgLlmMs: number
  avgLatencyMs: number
  latencyP90Ms: number
  latencyMaxMs: number
}> {
  const groups = new Map<string, { mode: string; asrOnly: boolean; engine: string; model: string; runs: PipelineRun[] }>()
  for (const run of inputRuns) {
    const asrOnly = Boolean(run.asrOnly)
    const engine = run.asrEngine || '-'
    const model = run.asrModel || '-'
    const key = JSON.stringify([run.mode, asrOnly, engine, model])
    const group = groups.get(key)
    if (group) group.runs.push(run)
    else groups.set(key, { mode: run.mode, asrOnly, engine, model, runs: [run] })
  }

  const average = (values: Array<number | null>) => {
    const present = values.filter((value): value is number => value !== null && Number.isFinite(value))
    return present.length ? Math.round(present.reduce((sum, value) => sum + value, 0) / present.length) : 0
  }

  return [...groups].map(([key, { mode, asrOnly, engine, model, runs: group }]) => {
    const successful = group.filter((run) => run.status === 'ok')
    const asrValues = successful.map((run) => run.asrMs).filter((value): value is number => value !== null && Number.isFinite(value))
    const latencyValues = successful.map((run) => run.latencyMs).filter((value): value is number => value !== null && Number.isFinite(value))
    return {
      key,
      mode,
      asrOnly,
      engine,
      model,
      okCount: successful.length,
      totalCount: group.length,
      avgSpeechMs: average(successful.map((run) => run.speechMs)),
      avgAsrMs: average(successful.map((run) => run.asrMs)),
      asrP90Ms: percentile(asrValues, 0.9),
      asrMaxMs: asrValues.length ? Math.round(Math.max(...asrValues)) : 0,
      avgLlmMs: average(successful.map((run) => run.llmMs)),
      avgLatencyMs: average(successful.map((run) => run.latencyMs)),
      latencyP90Ms: percentile(latencyValues, 0.9),
      latencyMaxMs: latencyValues.length ? Math.round(Math.max(...latencyValues)) : 0,
    }
  })
}
