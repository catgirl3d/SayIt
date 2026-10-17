import { describe, expect, it } from 'vitest'
import type { TextContext } from '@/types/appContext'
import type { StartOptions } from '../types'
import {
  createIntegratedSkipResult,
  resolveAiPolishRoute,
  type AiPolishRoute,
  type AiPolishRouteInput,
} from '../aiPolicy'

const routeCases: Array<{
  name: string
  input: AiPolishRouteInput
  expected: AiPolishRoute
}> = [
  {
    name: 'routes server managed runs to the server without a translation switch',
    input: { workMode: 'server', serverAiSource: 'managed', selectionAiChosen: false },
    expected: 'server_managed',
  },
  {
    name: 'routes server custom runs to the client',
    input: { workMode: 'server', serverAiSource: 'custom', selectionAiChosen: false },
    expected: 'client',
  },
  {
    name: 'selection AI overrides the server-managed source',
    input: { workMode: 'server', serverAiSource: 'managed', selectionAiChosen: true },
    expected: 'client',
  },
  {
    name: 'selection AI overrides the server custom source',
    input: { workMode: 'server', serverAiSource: 'custom', selectionAiChosen: true },
    expected: 'client',
  },
  {
    name: 'routes cloud integrated ASR without translation to the integrated engine',
    input: { workMode: 'cloud_api', integratedAsr: true, requireTranslation: false, selectionAiChosen: false },
    expected: 'integrated',
  },
  {
    name: 'routes cloud integrated ASR with translation to the client',
    input: { workMode: 'cloud_api', integratedAsr: true, requireTranslation: true, selectionAiChosen: false },
    expected: 'client',
  },
  {
    name: 'selection AI overrides cloud integrated ASR',
    input: { workMode: 'cloud_api', integratedAsr: true, requireTranslation: false, selectionAiChosen: true },
    expected: 'client',
  },
  {
    name: 'selection AI overrides translated cloud integrated ASR',
    input: { workMode: 'cloud_api', integratedAsr: true, requireTranslation: true, selectionAiChosen: true },
    expected: 'client',
  },
  {
    name: 'routes cloud non-integrated ASR without translation to the client',
    input: { workMode: 'cloud_api', integratedAsr: false, requireTranslation: false, selectionAiChosen: false },
    expected: 'client',
  },
  {
    name: 'routes cloud non-integrated ASR with translation to the client',
    input: { workMode: 'cloud_api', integratedAsr: false, requireTranslation: true, selectionAiChosen: false },
    expected: 'client',
  },
  {
    name: 'selection AI keeps cloud non-integrated ASR on the client',
    input: { workMode: 'cloud_api', integratedAsr: false, requireTranslation: false, selectionAiChosen: true },
    expected: 'client',
  },
  {
    name: 'selection AI keeps translated cloud non-integrated ASR on the client',
    input: { workMode: 'cloud_api', integratedAsr: false, requireTranslation: true, selectionAiChosen: true },
    expected: 'client',
  },
  {
    name: 'routes local runs to the client',
    input: { workMode: 'local' },
    expected: 'client',
  },
]

describe('resolveAiPolishRoute', () => {
  it.each(routeCases)('$name', ({ input, expected }) => {
    expect(resolveAiPolishRoute(input)).toBe(expected)
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

describe('createIntegratedSkipResult', () => {
  it('uses ASR text and leaves contextApplied undefined without text context', () => {
    expect(createIntegratedSkipResult(undefined, 'recognized')).toStrictEqual({
      llmText: 'recognized',
      llmMs: 0,
      contextApplied: undefined,
      aiSource: 'none',
      aiStatus: 'skipped',
    })
  })

  it('uses ASR text when options exist without text context', () => {
    expect(createIntegratedSkipResult({}, 'recognized')).toStrictEqual({
      llmText: 'recognized',
      llmMs: 0,
      contextApplied: undefined,
      aiSource: 'none',
      aiStatus: 'skipped',
    })
  })

  it('uses non-empty selected text and marks context as not applied', () => {
    expect(createIntegratedSkipResult(makeStartOptions('selected'), 'recognized')).toStrictEqual({
      llmText: 'selected',
      llmMs: 0,
      contextApplied: false,
      aiSource: 'none',
      aiStatus: 'skipped',
    })
  })

  it('falls back to ASR text for an empty selected text value', () => {
    expect(createIntegratedSkipResult(makeStartOptions(''), 'recognized')).toStrictEqual({
      llmText: 'recognized',
      llmMs: 0,
      contextApplied: false,
      aiSource: 'none',
      aiStatus: 'skipped',
    })
  })

  it('preserves whitespace-only selected text', () => {
    expect(createIntegratedSkipResult(makeStartOptions('   '), 'recognized')).toStrictEqual({
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

    createIntegratedSkipResult(startOptions, 'recognized')

    expect(startOptions).toStrictEqual(before)
    expect(startOptions.textContext).toBe(originalTextContext)
  })
})
