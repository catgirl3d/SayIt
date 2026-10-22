import { beforeEach, describe, expect, it, vi } from 'vitest'

const boundaries = vi.hoisted(() => ({
  addRuntimeEvent: vi.fn(),
}))

vi.mock('../../debugLog', () => ({
  addRuntimeEvent: (...args: unknown[]) => boundaries.addRuntimeEvent(...args),
}))

import {
  logAiOutcome,
  normalizeServerLlmDebug,
  outcomeToResultFields,
  resolveAiOutcome,
  type AiOutcome,
  type AiOutcomeEvidence,
} from '../aiOutcome'

const outcomeCases: Array<{
  name: string
  evidence: AiOutcomeEvidence
  expected: AiOutcome
}> = [
  {
    name: 'an empty recognition runs no AI',
    evidence: { kind: 'skipped', cause: 'empty_asr' },
    expected: { source: 'none', status: 'skipped', attempted: false, skipCause: 'empty_asr', basis: 'skip' },
  },
  {
    name: 'disabled AI is skipped, not unavailable',
    evidence: { kind: 'skipped', cause: 'ai_disabled' },
    expected: { source: 'none', status: 'skipped', attempted: false, skipCause: 'ai_disabled', basis: 'skip' },
  },
  {
    name: 'a recording below the duration threshold is skipped',
    evidence: { kind: 'skipped', cause: 'below_min_duration' },
    expected: { source: 'none', status: 'skipped', attempted: false, skipCause: 'below_min_duration', basis: 'skip' },
  },
  {
    name: 'integrated ASR cleanup is reported as a skipped AI stage',
    evidence: { kind: 'skipped', cause: 'integrated' },
    expected: { source: 'none', status: 'skipped', attempted: false, skipCause: 'integrated', basis: 'skip' },
  },
  {
    name: 'server llm_debug with a provider proves an applied, attempted run',
    evidence: { kind: 'server', llmMs: 42, llmDebug: { provider: 'openai' } },
    expected: { source: 'server', status: 'applied', attempted: true, basis: 'llm_debug' },
  },
  {
    name: 'server llm_debug provider wins over a zero llm_ms',
    evidence: { kind: 'server', llmMs: 0, llmDebug: { provider: 'openai' } },
    expected: { source: 'server', status: 'applied', attempted: true, basis: 'llm_debug' },
  },
  {
    name: 'server llm_debug error is an attempted run that stays unavailable, never failed',
    evidence: { kind: 'server', llmMs: 0, llmDebug: { errored: true } },
    expected: { source: 'server', status: 'unavailable', attempted: true, basis: 'llm_debug' },
  },
  {
    name: 'server llm_debug skipped means the server never called its LLM',
    evidence: { kind: 'server', llmMs: 0, llmDebug: { skipped: true } },
    expected: { source: 'server', status: 'unavailable', attempted: false, basis: 'llm_debug' },
  },
  {
    name: 'an empty server llm_debug means the server never called its LLM',
    evidence: { kind: 'server', llmMs: 0, llmDebug: {} },
    expected: { source: 'server', status: 'unavailable', attempted: false, basis: 'llm_debug' },
  },
  {
    name: 'an older server without llm_debug falls back to a positive llm_ms',
    evidence: { kind: 'server', llmMs: 42 },
    expected: { source: 'server', status: 'applied', attempted: true, basis: 'llm_ms' },
  },
  {
    name: 'an older server without llm_debug and a zero llm_ms is unavailable',
    evidence: { kind: 'server', llmMs: 0 },
    expected: { source: 'server', status: 'unavailable', attempted: false, basis: 'llm_ms' },
  },
  {
    name: 'an incomplete client profile is unavailable and never attempted',
    evidence: { kind: 'client_profile_incomplete' },
    expected: {
      source: 'custom',
      status: 'unavailable',
      reason: 'incomplete_profile',
      attempted: false,
      basis: 'client',
    },
  },
  {
    name: 'a client answer with text is applied',
    evidence: { kind: 'client_result', hasText: true },
    expected: { source: 'custom', status: 'applied', attempted: true, basis: 'client' },
  },
  {
    name: 'a client answer without text failed with an empty result',
    evidence: { kind: 'client_result', hasText: false },
    expected: { source: 'custom', status: 'failed', reason: 'empty_result', attempted: true, basis: 'client' },
  },
  {
    name: 'a client timeout failed with the timeout reason',
    evidence: { kind: 'client_error', timedOut: true, emptyCompletion: false },
    expected: { source: 'custom', status: 'failed', reason: 'timeout', attempted: true, basis: 'client' },
  },
  {
    name: 'a timeout wins over an empty completion code',
    evidence: { kind: 'client_error', timedOut: true, emptyCompletion: true },
    expected: { source: 'custom', status: 'failed', reason: 'timeout', attempted: true, basis: 'client' },
  },
  {
    name: 'a rejected empty completion failed with an empty result',
    evidence: { kind: 'client_error', timedOut: false, emptyCompletion: true },
    expected: { source: 'custom', status: 'failed', reason: 'empty_result', attempted: true, basis: 'client' },
  },
  {
    name: 'any other client rejection failed with a provider error',
    evidence: { kind: 'client_error', timedOut: false, emptyCompletion: false },
    expected: { source: 'custom', status: 'failed', reason: 'provider_error', attempted: true, basis: 'client' },
  },
  {
    name: 'a failure before the request was sent is failed without a reason and never attempted',
    evidence: { kind: 'client_error_before_request' },
    expected: { source: 'custom', status: 'failed', attempted: false, basis: 'client' },
  },
]

describe('resolveAiOutcome', () => {
  it.each(outcomeCases)('$name', ({ evidence, expected }) => {
    expect(resolveAiOutcome(evidence)).toStrictEqual(expected)
  })
})

describe('normalizeServerLlmDebug', () => {
  it.each([undefined, null, 'text', 7, ['provider']])('treats %j as an older server without llm_debug', (raw) => {
    expect(normalizeServerLlmDebug(raw)).toBeUndefined()
  })

  it('reads a successful call as the provider name', () => {
    expect(normalizeServerLlmDebug({ provider: 'openai', model: 'm', messages: [{ content: 'secret' }] })).toStrictEqual({
      provider: 'openai',
      skipped: false,
      errored: false,
    })
  })

  it('reads a skipped call and an empty object as no LLM call', () => {
    expect(normalizeServerLlmDebug({ skipped: true })).toStrictEqual({ provider: undefined, skipped: true, errored: false })
    expect(normalizeServerLlmDebug({})).toStrictEqual({ provider: undefined, skipped: false, errored: false })
  })

  it('detects an errored call by the key even when the exception had no message', () => {
    expect(normalizeServerLlmDebug({ error: '' })).toStrictEqual({ provider: undefined, skipped: false, errored: true })
  })

  it('never carries the error text, the prompt messages or the text context', () => {
    const evidence = normalizeServerLlmDebug({
      error: 'upstream said: secret',
      messages: [{ content: 'secret' }],
      raw_output: 'secret',
      text_context: { selected_len: 4 },
    })

    expect(JSON.stringify(evidence)).not.toContain('secret')
    expect(Object.keys(evidence!).sort()).toEqual(['errored', 'provider', 'skipped'])
  })
})

describe('outcomeToResultFields', () => {
  it('maps source and status and omits an undefined reason key', () => {
    const fields = outcomeToResultFields(resolveAiOutcome({ kind: 'skipped', cause: 'empty_asr' }))

    // toStrictEqual treats a present-but-undefined key as a difference, and the existing
    // result suites assert exact objects.
    expect(fields).toStrictEqual({ aiSource: 'none', aiStatus: 'skipped' })
  })

  it('carries the failure reason when the outcome has one', () => {
    const fields = outcomeToResultFields(resolveAiOutcome({ kind: 'client_error', timedOut: true, emptyCompletion: false }))

    expect(fields).toStrictEqual({ aiSource: 'custom', aiStatus: 'failed', aiFailureReason: 'timeout' })
  })

  it('never leaks attempted, skipCause or basis into the persisted result fields', () => {
    for (const { evidence } of outcomeCases) {
      const keys = Object.keys(outcomeToResultFields(resolveAiOutcome(evidence)))
      expect(keys).not.toContain('attempted')
      expect(keys).not.toContain('skipCause')
      expect(keys).not.toContain('basis')
    }
  })
})

describe('logAiOutcome', () => {
  beforeEach(() => {
    boundaries.addRuntimeEvent.mockReset()
  })

  it('writes exactly one structured ai.outcome event', () => {
    logAiOutcome('server', resolveAiOutcome({ kind: 'server', llmMs: 42, llmDebug: { provider: 'openai' } }), undefined, {
      llmMs: 42,
      provider: 'openai',
    })

    expect(boundaries.addRuntimeEvent).toHaveBeenCalledTimes(1)
    expect(boundaries.addRuntimeEvent).toHaveBeenCalledWith('info', 'server', 'ai.outcome', {
      source: 'server',
      status: 'applied',
      reason: undefined,
      attempted: true,
      skipCause: undefined,
      basis: 'llm_debug',
      llmMs: 42,
      provider: 'openai',
    })
  })

  it.each([
    { name: 'absent start options', startOptions: undefined, expectedCalls: 1 },
    { name: 'a run that leaves the flag unset', startOptions: {}, expectedCalls: 1 },
    { name: 'an explicit opt-in', startOptions: { aiOutcomeLog: true }, expectedCalls: 1 },
    { name: 'a segment consumer that opts out', startOptions: { aiOutcomeLog: false }, expectedCalls: 0 },
  ])('honors the segment-consumer opt-out for $name', ({ startOptions, expectedCalls }) => {
    logAiOutcome('server', resolveAiOutcome({ kind: 'skipped', cause: 'empty_asr' }), startOptions)

    expect(boundaries.addRuntimeEvent).toHaveBeenCalledTimes(expectedCalls)
  })

  it('records the skip cause and failure reason alongside the attempted flag', () => {
    logAiOutcome('local', resolveAiOutcome({ kind: 'skipped', cause: 'below_min_duration' }), undefined)
    logAiOutcome('cloud_api', resolveAiOutcome({ kind: 'client_error', timedOut: false, emptyCompletion: false }), undefined)

    expect(boundaries.addRuntimeEvent).toHaveBeenNthCalledWith(1, 'info', 'local', 'ai.outcome', expect.objectContaining({
      source: 'none',
      status: 'skipped',
      attempted: false,
      skipCause: 'below_min_duration',
    }))
    expect(boundaries.addRuntimeEvent).toHaveBeenNthCalledWith(2, 'info', 'cloud_api', 'ai.outcome', expect.objectContaining({
      source: 'custom',
      status: 'failed',
      reason: 'provider_error',
      attempted: true,
    }))
  })
})
