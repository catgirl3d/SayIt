import { describe, expect, it } from 'vitest'
import {
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
]

describe('resolveAiPolishRoute', () => {
  it.each(routeCases)('$name', ({ input, expected }) => {
    expect(resolveAiPolishRoute(input)).toBe(expected)
  })
})
