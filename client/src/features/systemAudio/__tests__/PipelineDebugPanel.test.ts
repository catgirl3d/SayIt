import { describe, expect, it } from 'vitest'
import { createRun } from '@/services/__tests__/pipelineRunFactory'
import { buildPipelineTsv, filterRuns } from '../PipelineDebugPanel'

describe('pipeline debug panel', () => {
  it('filters pipeline runs by mode and status groups', () => {
    const runs = [
      createRun({ id: 1, status: 'ok', mode: 'local' }),
      createRun({ id: 2, status: 'failed', mode: 'local' }),
      createRun({ id: 3, status: 'timeout', mode: 'cloud_api' }),
      createRun({ id: 4, status: 'cancelled', mode: 'cloud_api' }),
      createRun({ id: 5, status: 'empty', mode: 'server' }),
      createRun({ id: 6, status: 'rejected', mode: 'server' }),
    ]

    expect(filterRuns(runs, { mode: 'cloud_api', status: 'problems' }).map((run) => run.id)).toEqual([3])
    expect(filterRuns(runs, { mode: 'all', status: 'problems' }).map((run) => run.id)).toEqual([2, 3, 5, 6])
    expect(filterRuns(runs, { mode: 'all', status: 'cancelled' }).map((run) => run.id)).toEqual([4])
  })

  it('exports filtered summaries and each visible run as tab-separated character-count rows', () => {
    const summary = [{
      key: 'local:sensevoice:small',
      mode: 'local',
      engine: 'sensevoice',
      model: 'small',
      asrOnly: false,
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
    const tsv = buildPipelineTsv(summary, runs, 'ASR-only')
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

  it('marks recognition-only summary and run rows in the TSV export', () => {
    const summary = [{
      key: 'local:asr-only:sensevoice:small',
      mode: 'local',
      engine: 'sensevoice',
      model: 'small',
      asrOnly: true,
      okCount: 1,
      totalCount: 1,
      avgSpeechMs: 100,
      avgAsrMs: 20,
      asrP90Ms: 20,
      asrMaxMs: 20,
      avgLlmMs: 0,
      avgLatencyMs: 25,
      latencyP90Ms: 25,
      latencyMaxMs: 25,
    }]
    const tsv = buildPipelineTsv(summary, [createRun({ id: 3, status: 'ok', asrOnly: true })], 'ASR-only')
    const lines = tsv.split('\n')

    expect(lines[1]).toContain('local · sensevoice / small · ASR-only')
    expect(lines[4].split('\t')[1]).toBe('local · ASR-only')
  })
})
