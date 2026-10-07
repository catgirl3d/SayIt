import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRun } from './pipelineRunFactory'

async function loadPipelineTrace() {
  const trace = await import('../pipelineTrace').catch(() => null)
  expect(trace).not.toBeNull()
  return trace!
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

    expect(trace.beginRun({ closeReason: 'silence', mode: 'local', speechMs: 320 })).toBeNull()
    trace.setPipelineActivity({ phase: 'asr', stageStartedAt: 1234 })
    trace.countFrame(1024, { phase: 'speech', segmentMs: 320 })
    trace.countDiscontinuity()
    trace.setQueueDepth(2)

    expect(trace.getPipelineSnapshot()).toMatchObject({
      enabled: false,
      counters: { frames: 0, frameBytes: 0, discontinuities: 0, segments: 0, completed: 0, failed: 0, queueDepth: 0, maxSpeechGapMs: 0 },
      activity: { phase: 'idle', segmentMs: 0, stageStartedAt: null },
      runs: [],
    })
  })

  it('records queue and end-to-end timings for a completed run', async () => {
    const trace = await loadPipelineTrace()
    trace.setPipelineDebugEnabled(true)
    vi.setSystemTime(new Date('2026-10-06T20:00:00.000Z'))

    const runId = trace.beginRun({ closeReason: 'silence', mode: 'local', speechMs: 640 })!
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
      counters: { frames: 1, frameBytes: 1024, discontinuities: 1, segments: 1, completed: 1, failed: 0, queueDepth: 0, maxSpeechGapMs: 0 },
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
      const runId = trace.beginRun({ closeReason: 'silence', mode: 'cloud_api', speechMs: 320 })!
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
      const runId = trace.beginRun({ closeReason: 'silence', mode: 'local', speechMs: index })!
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
    const runId = trace.beginRun({ closeReason: 'silence', mode: 'local', speechMs: 320 })!
    trace.finishRun(runId, {})
    trace.countFrame(2048)

    trace.clearPipelineTrace()

    expect(trace.getPipelineSnapshot()).toMatchObject({
      enabled: true,
      counters: { frames: 0, frameBytes: 0, discontinuities: 0, segments: 0, completed: 0, failed: 0, queueDepth: 0, maxSpeechGapMs: 0 },
      activity: { phase: 'idle', segmentMs: 0, stageStartedAt: null },
      runs: [],
    })
  })

  it('groups engine timings by work mode, ASR engine, and model while skipping null timings', async () => {
    const trace = await loadPipelineTrace()
    trace.setPipelineDebugEnabled(true)

    const firstLocal = trace.beginRun({ closeReason: 'silence', mode: 'local', speechMs: 100 })!
    trace.finishRun(firstLocal, { asrEngine: 'sensevoice', asrModel: 'small', asrMs: 20, llmMs: 40 })
    const secondLocal = trace.beginRun({ closeReason: 'silence', mode: 'local', speechMs: 300 })!
    trace.finishRun(secondLocal, { asrEngine: 'sensevoice', asrModel: 'small', asrMs: null, llmMs: 20 })
    const cloud = trace.beginRun({ closeReason: 'silence', mode: 'cloud_api', speechMs: 100 })!
    trace.finishRun(cloud, { asrMs: 10, llmMs: 10 })

    const summary = trace.summarizeByEngine([...trace.getPipelineSnapshot().runs])
    const local = summary.find((item) => item.mode === 'local')
    const cloudApi = summary.find((item) => item.mode === 'cloud_api')

    expect(local).toMatchObject({
      key: JSON.stringify(['local', false, 'sensevoice', 'small']),
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
      key: JSON.stringify(['cloud_api', false, '-', '-']),
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
      key: JSON.stringify(['local', false, 'sensevoice', 'small']),
      mode: 'local',
      engine: 'sensevoice',
      model: 'small',
      asrOnly: false,
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

  it('keeps engine and model values containing separators in separate groups', async () => {
    const trace = await loadPipelineTrace()
    trace.setPipelineDebugEnabled(true)
    const first = trace.beginRun({ closeReason: 'silence', mode: 'local', speechMs: 100 })!
    trace.finishRun(first, { asrEngine: 'cloud:custom', asrModel: 'base:model' })
    const second = trace.beginRun({ closeReason: 'silence', mode: 'local', speechMs: 100 })!
    trace.finishRun(second, { asrEngine: 'cloud', asrModel: 'custom:base:model' })

    const summary = trace.summarizeByEngine([...trace.getPipelineSnapshot().runs])

    expect(summary).toHaveLength(2)
    expect(summary.map(({ engine, model }) => [engine, model])).toEqual([
      ['cloud:custom', 'base:model'],
      ['cloud', 'custom:base:model'],
    ])
    expect(new Set(summary.map(({ key }) => key)).size).toBe(2)
  })

  it('records recognition-only runs and keeps their engine averages separate from translated runs', async () => {
    const trace = await loadPipelineTrace()
    trace.setPipelineDebugEnabled(true)
    const runId = trace.beginRun({ closeReason: 'silence', mode: 'local', speechMs: 100, asrOnly: true })!
    trace.finishRun(runId, { asrMs: 20, llmMs: 0 })

    expect(trace.getPipelineSnapshot().runs[0]).toMatchObject({ status: 'ok', asrOnly: true })
    const summary = trace.summarizeByEngine([
      createRun({ id: 1, status: 'ok', asrOnly: false, speechMs: 100, asrMs: 20, llmMs: 30 }),
      createRun({ id: 2, status: 'ok', asrOnly: true, speechMs: 300, asrMs: 40, llmMs: 0 }),
    ])

    expect(summary).toMatchObject([
      { key: JSON.stringify(['local', false, 'sensevoice', 'small']), asrOnly: false, totalCount: 1, avgAsrMs: 20 },
      { key: JSON.stringify(['local', true, 'sensevoice', 'small']), asrOnly: true, totalCount: 1, avgAsrMs: 40 },
    ])
  })

  it('does not let old run IDs finish after clear or disable and re-enable', async () => {
    const trace = await loadPipelineTrace()
    trace.setPipelineDebugEnabled(true)
    const clearedRunId = trace.beginRun({ closeReason: 'silence', mode: 'local', speechMs: 320 })!
    trace.clearPipelineTrace()
    const disabledRunId = trace.beginRun({ closeReason: 'silence', mode: 'local', speechMs: 320 })!
    trace.setPipelineDebugEnabled(false)
    trace.setPipelineDebugEnabled(true)
    const currentRunId = trace.beginRun({ closeReason: 'silence', mode: 'cloud_api', speechMs: 640 })!

    trace.finishRun(clearedRunId, {})
    trace.finishRun(disabledRunId, {})
    trace.finishRun(currentRunId, {})

    expect(trace.getPipelineSnapshot().runs.map((run) => run.id)).toEqual([currentRunId])
    expect(currentRunId).toBeGreaterThan(disabledRunId)
  })

  it('keeps the reason a segment was closed on completed and failed runs', async () => {
    const trace = await loadPipelineTrace()
    trace.setPipelineDebugEnabled(true)
    const completed = trace.beginRun({ closeReason: 'pause', mode: 'local', speechMs: 640 })!
    trace.finishRun(completed, {})
    const failed = trace.beginRun({ closeReason: 'cap', mode: 'local', speechMs: 640 })!
    trace.failRun(failed, 'failed', 'boom')

    expect(trace.getPipelineSnapshot().runs.map((run) => run.closeReason)).toEqual(['pause', 'cap'])
  })

  it('tracks the longest gap between frames while speech was open, and only while enabled', async () => {
    const trace = await loadPipelineTrace()
    trace.noteSpeechFrameGap(900)
    expect(trace.getPipelineSnapshot().counters.maxSpeechGapMs).toBe(0)

    trace.setPipelineDebugEnabled(true)
    trace.noteSpeechFrameGap(40)
    expect(trace.getPipelineSnapshot().counters.maxSpeechGapMs).toBe(40)
    trace.noteSpeechFrameGap(900.4)
    trace.noteSpeechFrameGap(100)
    expect(trace.getPipelineSnapshot().counters.maxSpeechGapMs).toBe(900)

    trace.clearPipelineTrace()
    expect(trace.getPipelineSnapshot().counters.maxSpeechGapMs).toBe(0)
  })

  it('does not publish a new snapshot for a gap that is not a new maximum', async () => {
    const trace = await loadPipelineTrace()
    trace.setPipelineDebugEnabled(true)
    trace.noteSpeechFrameGap(300)
    const before = trace.getPipelineSnapshot()
    trace.noteSpeechFrameGap(300)
    trace.noteSpeechFrameGap(20)

    expect(trace.getPipelineSnapshot()).toBe(before)
  })

  it('counts runs per close reason, including reasons that never occurred', async () => {
    const trace = await loadPipelineTrace()
    const runs = [
      createRun({ id: 1, status: 'ok', closeReason: 'silence' }),
      createRun({ id: 2, status: 'ok', closeReason: 'cap' }),
      createRun({ id: 3, status: 'failed', closeReason: 'cap' }),
      createRun({ id: 4, status: 'ok', closeReason: 'dropout' }),
    ]

    expect(trace.countCloseReasons(runs)).toEqual({ silence: 1, pause: 0, cap: 2, gap: 0, dropout: 1 })
    expect(trace.countCloseReasons([])).toEqual({ silence: 0, pause: 0, cap: 0, gap: 0, dropout: 0 })
  })
})
