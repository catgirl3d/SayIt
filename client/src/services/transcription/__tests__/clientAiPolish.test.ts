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

import { resolveContextAwareOutput } from '../../contextAware'
import { polishWithClientAi } from '../clientAiPolish'

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
    })

    expect(resolveContextAwareOutput({
      asrText: ASR_COMMAND,
      llmText: polished!.llmText,
    }).baseText).toBe(ASR_COMMAND)
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
    { provider: 'openai_compat', apiUrl: 'https://example.test/v1', model: 'fixture-model', hasKey: false, hasModel: true },
    { provider: 'unknown-provider', apiUrl: 'https://example.test/v1', model: 'fixture-model', hasKey: false, hasModel: true },
    { provider: 'ollama', apiUrl: 'http://127.0.0.1:11434', model: '', hasKey: true, hasModel: false },
  ])('uses catalog key completeness for an incomplete $provider profile', async ({ provider, apiUrl, model, hasKey, hasModel }) => {
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
      aiProvider: provider,
    })
    expect(boundaries.addRuntimeEvent).toHaveBeenCalledWith(
      'warn',
      'test',
      'Custom AI is selected but its active profile is incomplete',
      { provider, hasUrl: true, hasKey, hasModel },
    )
  })
})
