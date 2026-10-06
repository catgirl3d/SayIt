import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PipelineRun } from '../pipelineTrace'

async function loadPipelineTrace() {
  const trace = await import('../pipelineTrace').catch(() => null)
  expect(trace).not.toBeNull()
  return trace!
}

function createRun(overrides: Partial<PipelineRun> & Pick<PipelineRun, 'id' | 'status'>): PipelineRun {
  const { id, status, ...fields } = overrides
  return {
    id,
    startedAt: 1_760_000_000_000 + id,
    mode: 'local',
    speechMs: 100,
    queueMs: 5,
    asrMs: 20,
    llmMs: 30,
    overlayMs: 2,
    latencyMs: 40,
    status,
    asrEngine: 'sensevoice',
    asrModel: 'small',
    asrChars: 12,
    captionChars: 10,
    ...fields,
  }
}

describe('pipeline trace', () => {
  beforeEach(async () => {
    vi.useFakeTimers()
    const trace = await loadPipelineTrace()
    trace.setPipelineDebugEnabled(false)
    trace.clearPipelineTrace()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('collects no runs or counters while disabled', async () => {
    const trace = await loadPipelineTrace()
    trace.setPipelineDebugEnabled(false)

    expect(trace.beginRun({ mode: 'local', speechMs: 320 })).toBeNull()
    expect(typeof trace.setPipelineActivity).toBe('function')
    if (typeof trace.setPipelineActivity !== 'function') return
    trace.setPipelineActivity({ phase: 'asr', stageStartedAt: 1234 })
    trace.countFrame(1024, { phase: 'speech', segmentMs: 320 })
    trace.countDiscontinuity()
    trace.setQueueDepth(2)

    expect(trace.getPipelineSnapshot()).toMatchObject({
      enabled: false,
      counters: { frames: 0, frameBytes: 0, discontinuities: 0, segments: 0, completed: 0, failed: 0, queueDepth: 0 },
      activity: { phase: 'idle', segmentMs: 0, stageStartedAt: null },
      runs: [],
    })
  })

  it('records queue and end-to-end timings for a completed run', async () => {
    const trace = await loadPipelineTrace()
    trace.setPipelineDebugEnabled(true)
    vi.setSystemTime(new Date('2026-10-06T20:00:00.000Z'))

    const runId = trace.beginRun({ mode: 'local', speechMs: 640 })!
    expect(trace.getPipelineSnapshot().counters.segments).toBe(1)
    trace.countFrame(1024)
    trace.countDiscontinuity()
    trace.setQueueDepth(1)
    vi.advanceTimersByTime(12)
    trace.markQueued(runId)
    trace.setQueueDepth(0)
    vi.advanceTimersByTime(20)
    trace.finishRun(runId, {
      asrMs: 14,
      llmMs: 23,
      overlayMs: 2,
      asrEngine: 'sensevoice',
      asrModel: 'sensevoice-small',
      aiProvider: 'ollama',
      aiModel: 'translator',
      asrChars: 18,
      captionChars: 20,
    })

    expect(trace.getPipelineSnapshot()).toMatchObject({
      enabled: true,
      counters: { frames: 1, frameBytes: 1024, discontinuities: 1, segments: 1, completed: 1, failed: 0, queueDepth: 0 },
      activity: { phase: 'idle', segmentMs: 0, stageStartedAt: null },
      runs: [{
        id: runId,
        mode: 'local',
        speechMs: 640,
        queueMs: 12,
        asrMs: 14,
        llmMs: 23,
        overlayMs: 2,
        latencyMs: 32,
        status: 'ok',
        asrEngine: 'sensevoice',
        asrModel: 'sensevoice-small',
        aiProvider: 'ollama',
        aiModel: 'translator',
        asrChars: 18,
        captionChars: 20,
      }],
    })
  })

  it('records terminal failure statuses once and excludes cancellations from failures', async () => {
    const trace = await loadPipelineTrace()
    trace.setPipelineDebugEnabled(true)

    for (const status of ['empty', 'rejected', 'failed', 'timeout', 'cancelled'] as const) {
      const runId = trace.beginRun({ mode: 'cloud_api', speechMs: 320 })!
      trace.failRun(runId, status, `${status} reason`)
      trace.failRun(runId, 'failed', 'duplicate')
    }

    expect(trace.getPipelineSnapshot()).toMatchObject({
      counters: { segments: 5, completed: 0, failed: 4 },
      runs: [
        { status: 'empty', reason: 'empty reason' },
        { status: 'rejected', reason: 'rejected reason' },
        { status: 'failed', reason: 'failed reason' },
        { status: 'timeout', reason: 'timeout reason' },
        { status: 'cancelled', reason: 'cancelled reason' },
      ],
    })
  })

  it('retains only the most recent 100 terminal runs', async () => {
    const trace = await loadPipelineTrace()
    trace.setPipelineDebugEnabled(true)
    const ids: number[] = []

    for (let index = 0; index < 101; index++) {
      const runId = trace.beginRun({ mode: 'local', speechMs: index })!
      ids.push(runId)
      trace.finishRun(runId, {})
    }

    const runs = trace.getPipelineSnapshot().runs
    expect(runs).toHaveLength(100)
    expect(runs[0].id).toBe(ids[1])
    expect(runs[99].id).toBe(ids[100])
  })

  it('clears counters and runs without disabling tracing', async () => {
    const trace = await loadPipelineTrace()
    trace.setPipelineDebugEnabled(true)
    const runId = trace.beginRun({ mode: 'local', speechMs: 320 })!
    trace.finishRun(runId, {})
    trace.countFrame(2048)

    trace.clearPipelineTrace()

    expect(trace.getPipelineSnapshot()).toMatchObject({
      enabled: true,
      counters: { frames: 0, frameBytes: 0, discontinuities: 0, segments: 0, completed: 0, failed: 0, queueDepth: 0 },
      activity: { phase: 'idle', segmentMs: 0, stageStartedAt: null },
      runs: [],
    })
  })

  it('groups engine timings by work mode, ASR engine, and model while skipping null timings', async () => {
    const trace = await loadPipelineTrace()
    trace.setPipelineDebugEnabled(true)

    const firstLocal = trace.beginRun({ mode: 'local', speechMs: 100 })!
    trace.finishRun(firstLocal, { asrEngine: 'sensevoice', asrModel: 'small', asrMs: 20, llmMs: 40 })
    const secondLocal = trace.beginRun({ mode: 'local', speechMs: 300 })!
    trace.finishRun(secondLocal, { asrEngine: 'sensevoice', asrModel: 'small', asrMs: null, llmMs: 20 })
    const cloud = trace.beginRun({ mode: 'cloud_api', speechMs: 100 })!
    trace.finishRun(cloud, { asrMs: 10, llmMs: 10 })

    const summary = trace.summarizeByEngine([...trace.getPipelineSnapshot().runs])
    const local = summary.find((item) => item.mode === 'local')
    const cloudApi = summary.find((item) => item.mode === 'cloud_api')

    expect(local).toMatchObject({
      key: JSON.stringify(['local', 'sensevoice', 'small']),
      engine: 'sensevoice',
      model: 'small',
      okCount: 2,
      totalCount: 2,
      avgSpeechMs: 200,
      avgAsrMs: 20,
      asrP90Ms: 20,
      asrMaxMs: 20,
      avgLlmMs: 30,
      avgLatencyMs: 0,
      latencyP90Ms: 0,
      latencyMaxMs: 0,
    })
    expect(cloudApi).toMatchObject({
      key: JSON.stringify(['cloud_api', '-', '-']),
      engine: '-',
      model: '-',
      okCount: 1,
      totalCount: 1,
      avgSpeechMs: 100,
      avgAsrMs: 10,
      asrP90Ms: 10,
      asrMaxMs: 10,
      avgLlmMs: 10,
      avgLatencyMs: 0,
      latencyP90Ms: 0,
      latencyMaxMs: 0,
    })
  })

  it('excludes cancelled and failed runs from timing averages but counts every run', async () => {
    const trace = await loadPipelineTrace()
    const summary = trace.summarizeByEngine([
      createRun({ id: 1, status: 'ok', speechMs: 100, asrMs: 20, llmMs: 30, latencyMs: 40 }),
      createRun({ id: 2, status: 'cancelled', speechMs: 10_000, asrMs: null, llmMs: null, latencyMs: 9_000 }),
      createRun({ id: 3, status: 'failed', speechMs: 30_000, asrMs: null, llmMs: null, latencyMs: 20_000 }),
    ])

    expect(summary).toEqual([{
      key: JSON.stringify(['local', 'sensevoice', 'small']),
      mode: 'local',
      engine: 'sensevoice',
      model: 'small',
      okCount: 1,
      totalCount: 3,
      avgSpeechMs: 100,
      avgAsrMs: 20,
      asrP90Ms: 20,
      asrMaxMs: 20,
      avgLlmMs: 30,
      avgLatencyMs: 40,
      latencyP90Ms: 40,
      latencyMaxMs: 40,
    }])
  })

  it('calculates nearest-rank percentiles over finite values and rounds to integers', async () => {
    const trace = await loadPipelineTrace()
    expect(typeof trace.percentile).toBe('function')
    if (typeof trace.percentile !== 'function') return

    expect(trace.percentile([], 0.9)).toBe(0)
    expect(trace.percentile([7.6], 0.9)).toBe(8)
    expect(trace.percentile([2.6, Number.NaN, 1.2, Number.POSITIVE_INFINITY], 0.5)).toBe(1)
    expect(trace.percentile([100, 20, 80, 10, 90, 40, 70, 30, 60, 50], 0.9)).toBe(90)
  })

  it('reports nearest-rank p90 and max across successful ASR and latency timings', async () => {
    const trace = await loadPipelineTrace()
    const summary = trace.summarizeByEngine(Array.from({ length: 10 }, (_, index) => createRun({
      id: index + 1,
      status: 'ok',
      asrMs: (index + 1) * 10,
      latencyMs: (index + 1) * 100,
    })))

    expect(summary[0]).toMatchObject({
      avgAsrMs: 55,
      asrP90Ms: 90,
      asrMaxMs: 100,
      avgLatencyMs: 550,
      latencyP90Ms: 900,
      latencyMaxMs: 1000,
    })
  })

  it('publishes frame counters and activity together, and clears live activity', async () => {
    const trace = await loadPipelineTrace()
    trace.setPipelineDebugEnabled(true)
    const listener = vi.fn()
    const unsubscribe = trace.subscribe(listener)

    trace.countFrame(1024, { phase: 'speech', segmentMs: 64 })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(trace.getPipelineSnapshot()).toMatchObject({
      counters: { frames: 1, frameBytes: 1024 },
      activity: { phase: 'speech', segmentMs: 64, stageStartedAt: null },
    })

    trace.setPipelineActivity({ phase: 'asr', stageStartedAt: 1234 })
    trace.setQueueDepth(2)
    expect(trace.getPipelineSnapshot()).toMatchObject({
      counters: { queueDepth: 2 },
      activity: { phase: 'asr', stageStartedAt: 1234 },
    })
    expect(trace.getPipelineSnapshot().activity).not.toHaveProperty('queueDepth')

    trace.clearPipelineTrace()
    expect(trace.getPipelineSnapshot().activity).toEqual({ phase: 'idle', segmentMs: 0, stageStartedAt: null })
    unsubscribe()
  })

  it('filters pipeline runs by mode and status groups', async () => {
    const panel = await import('../../features/systemAudio/PipelineDebugPanel')
    expect(typeof panel.filterRuns).toBe('function')
    if (typeof panel.filterRuns !== 'function') return

    const runs = [
      createRun({ id: 1, status: 'ok', mode: 'local' }),
      createRun({ id: 2, status: 'failed', mode: 'local' }),
      createRun({ id: 3, status: 'timeout', mode: 'cloud_api' }),
      createRun({ id: 4, status: 'cancelled', mode: 'cloud_api' }),
      createRun({ id: 5, status: 'empty', mode: 'server' }),
      createRun({ id: 6, status: 'rejected', mode: 'server' }),
    ]

    expect(panel.filterRuns(runs, { mode: 'cloud_api', status: 'problems' }).map((run) => run.id)).toEqual([3])
    expect(panel.filterRuns(runs, { mode: 'all', status: 'problems' }).map((run) => run.id)).toEqual([2, 3, 5, 6])
    expect(panel.filterRuns(runs, { mode: 'all', status: 'cancelled' }).map((run) => run.id)).toEqual([4])
  })

  it('exports filtered summaries and each visible run as tab-separated character-count rows', async () => {
    const panel = await import('../../features/systemAudio/PipelineDebugPanel')
    expect(typeof panel.buildPipelineTsv).toBe('function')
    if (typeof panel.buildPipelineTsv !== 'function') return

    const summary = [{
      key: 'local:sensevoice:small',
      mode: 'local',
      engine: 'sensevoice',
      model: 'small',
      okCount: 1,
      totalCount: 1,
      avgSpeechMs: 100,
      avgAsrMs: 20,
      asrP90Ms: 20,
      asrMaxMs: 20,
      avgLlmMs: 30,
      avgLatencyMs: 40,
      latencyP90Ms: 40,
      latencyMaxMs: 40,
    }]
    const runs = [
      createRun({ id: 1, status: 'ok', asrChars: 15, captionChars: 12 }),
      createRun({ id: 2, status: 'failed', asrChars: 0, captionChars: 0 }),
    ]
    const tsv = panel.buildPipelineTsv(summary, runs)
    const lines = tsv.split('\n')

    expect(lines[0]).toBe('engine/model\tOK / total runs\tavg speech ms\tavg ASR ms\tASR p90 ms\tASR max ms\tavg LLM ms\tavg latency ms\tlatency p90 ms\tlatency max ms')
    expect(lines[1]).toBe('local · sensevoice / small\t1 / 1\t100\t20\t20\t20\t30\t40\t40\t40')
    expect(lines[2]).toBe('')
    expect(lines[3]).toBe('time\tmode\tspeech ms\tqueue ms\tASR ms\tLLM ms\toverlay ms\tlatency ms\tstatus\tASR / caption chars')
    expect(lines.slice(4)).toHaveLength(2)
    expect(lines[4].split('\t')).toHaveLength(10)
    expect(lines[4].endsWith('\t15 / 12')).toBe(true)
    expect(tsv).not.toContain('Original speech')
  })

  it('keeps engine and model values containing separators in separate groups', async () => {
    const trace = await loadPipelineTrace()
    trace.setPipelineDebugEnabled(true)
    const first = trace.beginRun({ mode: 'local', speechMs: 100 })!
    trace.finishRun(first, { asrEngine: 'cloud:custom', asrModel: 'base:model' })
    const second = trace.beginRun({ mode: 'local', speechMs: 100 })!
    trace.finishRun(second, { asrEngine: 'cloud', asrModel: 'custom:base:model' })

    const summary = trace.summarizeByEngine([...trace.getPipelineSnapshot().runs])

    expect(summary).toHaveLength(2)
    expect(summary.map(({ engine, model }) => [engine, model])).toEqual([
      ['cloud:custom', 'base:model'],
      ['cloud', 'custom:base:model'],
    ])
    expect(new Set(summary.map(({ key }) => key)).size).toBe(2)
  })

  it('does not let old run IDs finish after clear or disable and re-enable', async () => {
    const trace = await loadPipelineTrace()
    trace.setPipelineDebugEnabled(true)
    const clearedRunId = trace.beginRun({ mode: 'local', speechMs: 320 })!
    trace.clearPipelineTrace()
    const disabledRunId = trace.beginRun({ mode: 'local', speechMs: 320 })!
    trace.setPipelineDebugEnabled(false)
    trace.setPipelineDebugEnabled(true)
    const currentRunId = trace.beginRun({ mode: 'cloud_api', speechMs: 640 })!

    trace.finishRun(clearedRunId, {})
    trace.finishRun(disabledRunId, {})
    trace.finishRun(currentRunId, {})

    expect(trace.getPipelineSnapshot().runs.map((run) => run.id)).toEqual([currentRunId])
    expect(currentRunId).toBeGreaterThan(disabledRunId)
  })
})
