import type { PipelineRun } from '../pipelineTrace'

export function createRun(overrides: Partial<PipelineRun> & Pick<PipelineRun, 'id' | 'status'>): PipelineRun {
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
