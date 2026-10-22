import { beforeEach, describe, expect, it, vi } from 'vitest'

const boundaries = vi.hoisted(() => ({
  invoke: vi.fn(),
  getSetting: vi.fn(),
  addRuntimeEvent: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => boundaries.invoke(...args),
}))
vi.mock('../../store', () => ({
  getSetting: (...args: unknown[]) => boundaries.getSetting(...args),
}))
vi.mock('../../debugLog', () => ({
  addRuntimeEvent: (...args: unknown[]) => boundaries.addRuntimeEvent(...args),
}))

import type { TextContext } from '@/types/appContext'
import { resolveContextAwareOutput } from '../../contextAware'
import { polishWithClientAi, skipPolish, skippedPolishResult } from '../clientAiPolish'
import type { StartOptions } from '../types'

const ASR_COMMAND = 'make this more formal'
const ORIGINAL_SELECTION = '\tOriginal selection\r\n  '

function selectionContext() {
  return {
    source: 'test-selection',
    textBefore: 'prefix',
    selectedText: ORIGINAL_SELECTION,
    textAfter: 'suffix',
    selectionTruncated: false,
  }
}

describe('client AI polish completion handling', () => {
  beforeEach(() => {
    boundaries.invoke.mockReset()
    boundaries.invoke.mockImplementation(async (command: string) => {
      if (command === 'cloud_polish') throw new Error('fixture rejection')
      return undefined
    })
    boundaries.addRuntimeEvent.mockReset()
    boundaries.getSetting.mockReset()
    boundaries.getSetting.mockImplementation(async (key: string, fallback: unknown) => {
      const settings: Record<string, string> = {
        'cloudAi.provider': 'ollama',
        'cloudAi.apiUrl': 'http://127.0.0.1:11434',
        'cloudAi.apiKey': '',
        'cloudAi.model': 'fixture-model',
      }
      return settings[key] ?? fallback
    })
  })

  it('preserves the original selection byte-for-byte when cloud polish rejects', async () => {
    const polished = await polishWithClientAi({
      asrText: ASR_COMMAND,
      durationSec: 2,
      startOptions: { runId: 1, textContext: selectionContext() },
      logSource: 'test',
    })
    expect(polished).not.toBeNull()
    expect(polished).toMatchObject({
      llmText: ORIGINAL_SELECTION,
      contextApplied: false,
      aiSource: 'custom',
      aiStatus: 'failed',
    })

    const resolved = resolveContextAwareOutput({
      asrText: ASR_COMMAND,
      llmText: polished!.llmText,
      contextApplied: polished!.contextApplied,
      textContext: selectionContext(),
    })

    expect(resolved.baseText).toBe(ORIGINAL_SELECTION)
    expect(resolved.baseText).not.toBe(ASR_COMMAND)
    expect(resolved.selectedEditWasApplied).toBe(false)
  })

  it('falls back to ASR text when cloud polish rejects without a selection', async () => {
    const polished = await polishWithClientAi({
      asrText: ASR_COMMAND,
      durationSec: 2,
      startOptions: { runId: 2 },
      logSource: 'test',
    })
    expect(polished).not.toBeNull()
    expect(polished).toMatchObject({
      llmText: ASR_COMMAND,
      aiSource: 'custom',
      aiStatus: 'failed',
      aiFailureReason: 'provider_error',
    })

    expect(resolveContextAwareOutput({
      asrText: ASR_COMMAND,
      llmText: polished!.llmText,
    }).baseText).toBe(ASR_COMMAND)
  })

  it('reports an empty provider answer as its own failure reason', async () => {
    boundaries.invoke.mockImplementation(async (command: string) => {
      if (command === 'cloud_polish') return { text: '', elapsed_ms: 9 }
      return undefined
    })

    const polished = await polishWithClientAi({
      asrText: ASR_COMMAND,
      durationSec: 2,
      startOptions: { runId: 7 },
      logSource: 'test',
    })

    expect(polished).toMatchObject({
      llmText: ASR_COMMAND,
      llmMs: 9,
      aiSource: 'custom',
      aiStatus: 'failed',
      aiFailureReason: 'empty_result',
    })
  })

  it('classifies the backend empty-completion failure as an empty result', async () => {
    boundaries.invoke.mockImplementation(async (command: string) => {
      if (command === 'cloud_polish') {
        throw 'sayit_error:empty_completion:AI returned no usable completion text'
      }
      return undefined
    })

    const polished = await polishWithClientAi({
      asrText: ASR_COMMAND,
      durationSec: 2,
      startOptions: { runId: 9 },
      logSource: 'test',
    })

    expect(polished).toMatchObject({
      llmText: ASR_COMMAND,
      aiSource: 'custom',
      aiStatus: 'failed',
      aiFailureReason: 'empty_result',
    })
  })

  it('reports a provider that never answers as a timeout, not a generic error', async () => {
    vi.useFakeTimers()
    try {
      boundaries.invoke.mockImplementation((command: string) => (
        command === 'cloud_polish' ? new Promise(() => {}) : Promise.resolve(undefined)
      ))

      const pending = polishWithClientAi({
        asrText: ASR_COMMAND,
        durationSec: 2,
        startOptions: { runId: 8 },
        logSource: 'test',
      })
      // Let the settings reads and the native invoke settle before the timeout timer exists.
      for (let i = 0; i < 20; i++) await Promise.resolve()
      await vi.advanceTimersByTimeAsync(8_000)
      const polished = await pending

      expect(polished).toMatchObject({
        llmText: ASR_COMMAND,
        aiSource: 'custom',
        aiStatus: 'failed',
        aiFailureReason: 'timeout',
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    { name: 'below', durationSec: 1.9, expectedCalls: 0, expectedStatus: 'skipped' as const },
    { name: 'at', durationSec: 2, expectedCalls: 1, expectedStatus: 'applied' as const },
    { name: 'above', durationSec: 2.1, expectedCalls: 1, expectedStatus: 'applied' as const },
  ])('applies the duration threshold when the audio is $name it', async ({ durationSec, expectedCalls, expectedStatus }) => {
    boundaries.invoke.mockImplementation(async (command: string) => (
      command === 'cloud_polish' ? { text: 'polished', elapsed_ms: 17 } : undefined
    ))

    const polished = await polishWithClientAi({
      asrText: ASR_COMMAND,
      durationSec,
      startOptions: { runId: 10, aiMinDurationSec: 2 },
      logSource: 'test',
    })

    expect(polished).toMatchObject({
      llmText: expectedStatus === 'skipped' ? ASR_COMMAND : 'polished',
      aiSource: expectedStatus === 'skipped' ? 'none' : 'custom',
      aiStatus: expectedStatus,
    })
    expect(boundaries.invoke.mock.calls.filter(([command]) => command === 'cloud_polish')).toHaveLength(expectedCalls)
  })

  it('treats a nonempty completion equal to ASR text as applied', async () => {
    boundaries.invoke.mockImplementation(async (command: string) => {
      if (command === 'cloud_polish') return { text: ASR_COMMAND, elapsed_ms: 17 }
      return undefined
    })

    const polished = await polishWithClientAi({
      asrText: ASR_COMMAND,
      durationSec: 2,
      startOptions: { runId: 3 },
      logSource: 'test',
    })

    expect(polished).toMatchObject({
      llmText: ASR_COMMAND,
      contextApplied: undefined,
      aiSource: 'custom',
      aiStatus: 'applied',
    })
  })

  it.each([
    { provider: 'openai_compat', apiUrl: 'https://example.test/v1', model: 'fixture-model', hasUrl: true, hasKey: false, hasModel: true },
    { provider: 'unknown-provider', apiUrl: 'https://example.test/v1', model: 'fixture-model', hasUrl: true, hasKey: false, hasModel: true },
    { provider: 'ollama', apiUrl: '', model: '', hasUrl: false, hasKey: true, hasModel: true },
  ])('uses catalog key completeness for an incomplete $provider profile', async ({ provider, apiUrl, model, hasUrl, hasKey, hasModel }) => {
    boundaries.getSetting.mockImplementation(async (key: string, fallback: unknown) => {
      const settings: Record<string, string> = {
        'cloudAi.provider': provider,
        'cloudAi.apiUrl': apiUrl,
        'cloudAi.apiKey': '',
        'cloudAi.model': model,
      }
      return settings[key] ?? fallback
    })

    const polished = await polishWithClientAi({
      asrText: ASR_COMMAND,
      durationSec: 2,
      startOptions: { runId: 4 },
      logSource: 'test',
    })

    expect(boundaries.invoke).not.toHaveBeenCalled()
    expect(polished).toMatchObject({
      llmText: ASR_COMMAND,
      llmMs: 0,
      aiSource: 'custom',
      aiStatus: 'unavailable',
      aiFailureReason: 'incomplete_profile',
      aiProvider: provider,
    })
    expect(boundaries.addRuntimeEvent).toHaveBeenCalledWith(
      'warn',
      'test',
      'Custom AI is selected but its active profile is incomplete',
      { provider, hasUrl, hasKey, hasModel },
    )
  })

  it.each([
    { name: 'empty', model: '' },
    { name: 'whitespace-only', model: ' \t ' },
  ])('runs a keyless provider whose model is $name with the native default', async ({ model }) => {
    boundaries.invoke.mockImplementation(async (command: string) => {
      if (command === 'cloud_polish') return { text: 'polished', elapsed_ms: 12 }
      return undefined
    })
    boundaries.getSetting.mockImplementation(async (key: string, fallback: unknown) => {
      const settings: Record<string, string> = {
        'cloudAi.provider': 'ollama',
        'cloudAi.apiUrl': 'http://127.0.0.1:11434',
        'cloudAi.apiKey': '',
        'cloudAi.model': model,
      }
      return settings[key] ?? fallback
    })

    const polished = await polishWithClientAi({
      asrText: ASR_COMMAND,
      durationSec: 2,
      startOptions: { runId: 6 },
      logSource: 'test',
    })

    const call = boundaries.invoke.mock.calls.find(([command]) => command === 'cloud_polish')
    expect(call?.[1]).toMatchObject({
      request: { ai_config: { provider: 'ollama', model: '' } },
    })
    expect(polished).toMatchObject({
      llmText: 'polished',
      aiStatus: 'applied',
      aiProvider: 'ollama',
    })
    expect(polished?.aiModel).toBeUndefined()
  })

  it('sends OpenAI request tuning with the openai provider', async () => {
    boundaries.invoke.mockImplementation(async (command: string) => {
      if (command === 'cloud_polish') return { text: 'polished', elapsed_ms: 12 }
      return undefined
    })
    boundaries.getSetting.mockImplementation(async (key: string, fallback: unknown) => {
      const settings: Record<string, string> = {
        'cloudAi.provider': 'openai',
        'cloudAi.apiUrl': 'http://127.0.0.1:65181/v1',
        'cloudAi.apiKey': 'sk-test',
        'cloudAi.model': 'gpt-5.5',
        'cloudAi.reasoningEffort': 'low',
        'cloudAi.serviceTier': 'fast',
      }
      return settings[key] ?? fallback
    })

    await polishWithClientAi({
      asrText: ASR_COMMAND,
      durationSec: 2,
      startOptions: { runId: 5 },
      logSource: 'test',
    })

    const call = boundaries.invoke.mock.calls.find(([command]) => command === 'cloud_polish')
    expect(call?.[1]).toMatchObject({
      request: {
        ai_config: {
          provider: 'openai',
          extra: { reasoning_effort: 'low', service_tier: 'fast' },
        },
      },
    })
  })

  it('keeps generic compatible providers free of OpenAI tuning fields', async () => {
    boundaries.invoke.mockImplementation(async (command: string) => {
      if (command === 'cloud_polish') return { text: 'polished', elapsed_ms: 12 }
      return undefined
    })
    boundaries.getSetting.mockImplementation(async (key: string, fallback: unknown) => {
      const settings: Record<string, string> = {
        'cloudAi.provider': 'deepseek',
        'cloudAi.apiUrl': 'https://api.deepseek.com',
        'cloudAi.apiKey': 'sk-test',
        'cloudAi.model': 'deepseek-v4-flash',
        'cloudAi.reasoningEffort': 'low',
        'cloudAi.serviceTier': 'fast',
      }
      return settings[key] ?? fallback
    })

    await polishWithClientAi({
      asrText: ASR_COMMAND,
      durationSec: 2,
      startOptions: { runId: 6 },
      logSource: 'test',
    })

    const call = boundaries.invoke.mock.calls.find(([command]) => command === 'cloud_polish')
    const aiConfig = (call?.[1] as { request: { ai_config: Record<string, unknown> } }).request.ai_config
    expect(aiConfig.extra).toBeUndefined()
  })
})

const makeTextContext = (selectedText: string): TextContext => ({
  source: 'uia',
  textBefore: 'before',
  selectedText,
  textAfter: 'after',
  selectionTruncated: false,
})

const makeStartOptions = (selectedText: string): Pick<StartOptions, 'textContext'> => ({
  textContext: makeTextContext(selectedText),
})

describe('skippedPolishResult', () => {
  it('uses ASR text and leaves contextApplied undefined without text context', () => {
    expect(skippedPolishResult('recognized')).toStrictEqual({
      llmText: 'recognized',
      llmMs: 0,
      contextApplied: undefined,
      aiSource: 'none',
      aiStatus: 'skipped',
    })
  })

  it('uses ASR text when options exist without text context', () => {
    expect(skippedPolishResult('recognized', {})).toStrictEqual({
      llmText: 'recognized',
      llmMs: 0,
      contextApplied: undefined,
      aiSource: 'none',
      aiStatus: 'skipped',
    })
  })

  it('uses non-empty selected text and marks context as not applied', () => {
    expect(skippedPolishResult('recognized', makeStartOptions('selected'))).toStrictEqual({
      llmText: 'selected',
      llmMs: 0,
      contextApplied: false,
      aiSource: 'none',
      aiStatus: 'skipped',
    })
  })

  it('falls back to ASR text for an empty selected text value', () => {
    expect(skippedPolishResult('recognized', makeStartOptions(''))).toStrictEqual({
      llmText: 'recognized',
      llmMs: 0,
      contextApplied: false,
      aiSource: 'none',
      aiStatus: 'skipped',
    })
  })

  it('preserves whitespace-only selected text', () => {
    expect(skippedPolishResult('recognized', makeStartOptions('   '))).toStrictEqual({
      llmText: '   ',
      llmMs: 0,
      contextApplied: false,
      aiSource: 'none',
      aiStatus: 'skipped',
    })
  })

  it('does not mutate the input options or nested text context', () => {
    const startOptions = makeStartOptions('selected')
    const originalTextContext = startOptions.textContext
    const before = {
      ...startOptions,
      textContext: { ...startOptions.textContext },
    }

    skippedPolishResult('recognized', startOptions)

    expect(startOptions).toStrictEqual(before)
    expect(startOptions.textContext).toBe(originalTextContext)
  })
})

describe('skipPolish', () => {
  beforeEach(() => {
    boundaries.addRuntimeEvent.mockReset()
  })

  it('returns the pure skipped result and writes one ai.outcome record with the cause', () => {
    const result = skipPolish('recognized', makeStartOptions('selected'), 'integrated', 'cloud_api')

    expect(result).toStrictEqual(skippedPolishResult('recognized', makeStartOptions('selected'), 'integrated'))
    expect(boundaries.addRuntimeEvent).toHaveBeenCalledTimes(1)
    expect(boundaries.addRuntimeEvent).toHaveBeenCalledWith('info', 'cloud_api', 'ai.outcome', {
      source: 'none',
      status: 'skipped',
      reason: undefined,
      attempted: false,
      skipCause: 'integrated',
      basis: 'skip',
    })
  })
})

describe('client AI polish ai.outcome record', () => {
  const outcomeEvents = () => boundaries.addRuntimeEvent.mock.calls.filter(([, , message]) => message === 'ai.outcome')

  beforeEach(() => {
    boundaries.invoke.mockReset()
    boundaries.invoke.mockImplementation(async (command: string) => {
      if (command === 'cloud_polish') throw new Error('fixture rejection')
      return undefined
    })
    boundaries.addRuntimeEvent.mockReset()
    boundaries.getSetting.mockReset()
    boundaries.getSetting.mockImplementation(async (key: string, fallback: unknown) => {
      const settings: Record<string, string> = {
        'cloudAi.provider': 'ollama',
        'cloudAi.apiUrl': 'http://127.0.0.1:11434',
        'cloudAi.apiKey': '',
        'cloudAi.model': 'fixture-model',
      }
      return settings[key] ?? fallback
    })
  })

  it('records an applied, attempted run with the provider, model and latency', async () => {
    boundaries.invoke.mockImplementation(async (command: string) => (
      command === 'cloud_polish' ? { text: 'polished', elapsed_ms: 17 } : undefined
    ))

    await polishWithClientAi({ asrText: ASR_COMMAND, durationSec: 2, startOptions: { runId: 1 }, logSource: 'test' })

    expect(outcomeEvents()).toStrictEqual([['info', 'test', 'ai.outcome', {
      source: 'custom',
      status: 'applied',
      reason: undefined,
      attempted: true,
      skipCause: undefined,
      basis: 'client',
      provider: 'ollama',
      model: 'fixture-model',
      llmMs: 17,
    }]])
  })

  it('records a rejected request as an attempted failure with its reason', async () => {
    await polishWithClientAi({ asrText: ASR_COMMAND, durationSec: 2, startOptions: { runId: 2 }, logSource: 'test' })

    expect(outcomeEvents()).toHaveLength(1)
    expect(outcomeEvents()[0][3]).toMatchObject({
      source: 'custom',
      status: 'failed',
      reason: 'provider_error',
      attempted: true,
    })
  })

  it('records an empty provider answer as an attempted empty_result failure', async () => {
    boundaries.invoke.mockImplementation(async (command: string) => (
      command === 'cloud_polish' ? { text: '', elapsed_ms: 9 } : undefined
    ))

    await polishWithClientAi({ asrText: ASR_COMMAND, durationSec: 2, startOptions: { runId: 3 }, logSource: 'test' })

    expect(outcomeEvents()).toHaveLength(1)
    expect(outcomeEvents()[0][3]).toMatchObject({ status: 'failed', reason: 'empty_result', attempted: true, llmMs: 9 })
  })

  it.each([
    { name: 'an empty recognition', asrText: '  ', startOptions: { runId: 4 }, durationSec: 2, skipCause: 'empty_asr' },
    { name: 'disabled AI', asrText: ASR_COMMAND, startOptions: { runId: 5, disableAi: true }, durationSec: 2, skipCause: 'ai_disabled' },
    { name: 'a short recording', asrText: ASR_COMMAND, startOptions: { runId: 6, aiMinDurationSec: 5 }, durationSec: 1, skipCause: 'below_min_duration' },
  ])('records $name as a skip that never issued a request', async ({ asrText, startOptions, durationSec, skipCause }) => {
    await polishWithClientAi({ asrText, durationSec, startOptions, logSource: 'test' })

    expect(boundaries.invoke).not.toHaveBeenCalled()
    expect(outcomeEvents()).toHaveLength(1)
    expect(outcomeEvents()[0][3]).toMatchObject({
      source: 'none',
      status: 'skipped',
      attempted: false,
      skipCause,
    })
  })

  it('records the stop-time skip cause for a disabled run, and ai_disabled when no cause is given', async () => {
    const withCause = await polishWithClientAi({
      asrText: ASR_COMMAND,
      durationSec: 1,
      startOptions: { runId: 20, disableAi: true, disableAiCause: 'below_min_duration' },
      logSource: 'test',
    })

    expect(outcomeEvents()).toHaveLength(1)
    expect(outcomeEvents()[0][3]).toMatchObject({ source: 'none', attempted: false, skipCause: 'below_min_duration' })
    boundaries.addRuntimeEvent.mockClear()

    const withoutCause = await polishWithClientAi({
      asrText: ASR_COMMAND,
      durationSec: 1,
      startOptions: { runId: 21, disableAi: true },
      logSource: 'test',
    })

    expect(outcomeEvents()).toHaveLength(1)
    expect(outcomeEvents()[0][3]).toMatchObject({ source: 'none', attempted: false, skipCause: 'ai_disabled' })
    expect(withCause).toStrictEqual(withoutCause)
    expect(boundaries.invoke).not.toHaveBeenCalled()
  })

  it('records an incomplete profile as unavailable and never attempted', async () => {
    boundaries.getSetting.mockImplementation(async (key: string, fallback: unknown) => {
      const settings: Record<string, string> = {
        'cloudAi.provider': 'openai_compat',
        'cloudAi.apiUrl': 'https://example.test/v1',
        'cloudAi.apiKey': '',
        'cloudAi.model': 'fixture-model',
      }
      return settings[key] ?? fallback
    })

    await polishWithClientAi({ asrText: ASR_COMMAND, durationSec: 2, startOptions: { runId: 7 }, logSource: 'test' })

    expect(boundaries.invoke).not.toHaveBeenCalled()
    expect(outcomeEvents()).toHaveLength(1)
    expect(outcomeEvents()[0][3]).toMatchObject({
      source: 'custom',
      status: 'unavailable',
      reason: 'incomplete_profile',
      attempted: false,
      provider: 'openai_compat',
    })
  })

  it.each([
    { name: 'an applied run', startOptions: { runId: 10, aiOutcomeLog: false }, asrText: ASR_COMMAND },
    { name: 'a skipped run', startOptions: { runId: 11, aiOutcomeLog: false, disableAi: true }, asrText: ASR_COMMAND },
    { name: 'an empty recognition', startOptions: { runId: 12, aiOutcomeLog: false }, asrText: ' ' },
  ])('writes no record for $name of a segment consumer, and leaves the result unchanged', async ({ startOptions, asrText }) => {
    boundaries.invoke.mockImplementation(async (command: string) => (
      command === 'cloud_polish' ? { text: 'polished', elapsed_ms: 17 } : undefined
    ))
    const withoutOptOut = await polishWithClientAi({
      asrText,
      durationSec: 2,
      startOptions: { ...startOptions, aiOutcomeLog: undefined },
      logSource: 'test',
    })
    boundaries.addRuntimeEvent.mockClear()

    const polished = await polishWithClientAi({ asrText, durationSec: 2, startOptions, logSource: 'test' })

    expect(outcomeEvents()).toHaveLength(0)
    expect(polished).toStrictEqual(withoutOptOut)
  })

  it('writes no record for a run that was superseded while it was in flight', async () => {
    const polished = await polishWithClientAi({
      asrText: ASR_COMMAND,
      durationSec: 2,
      startOptions: { runId: 8 },
      logSource: 'test',
      isCurrent: () => false,
    })

    expect(polished).toBeNull()
    expect(outcomeEvents()).toHaveLength(0)
  })

  it('never logs recognized text, the selection or the provider error text', async () => {
    await polishWithClientAi({
      asrText: ASR_COMMAND,
      durationSec: 2,
      startOptions: { runId: 9, textContext: selectionContext() },
      logSource: 'test',
    })

    const serialized = JSON.stringify(outcomeEvents())
    expect(serialized).not.toContain(ASR_COMMAND)
    expect(serialized).not.toContain('Original selection')
    expect(serialized).not.toContain('fixture rejection')
  })
})
