import { describe, expect, it } from 'vitest'
import { HOTWORD_TOKEN_BUDGET } from '../budget'
import { deepgramHotwordNotice } from '../deepgramNotice'

describe('deepgramHotwordNotice', () => {
  it('reports the opt-in gate whenever the Deepgram profile has not enabled hotword sending', () => {
    expect(deepgramHotwordNotice({ provider: 'deepgram', keytermsEnabled: false, tokenEstimate: 0 })).toBe('deepgramGate')
    expect(
      deepgramHotwordNotice({ provider: 'deepgram', keytermsEnabled: false, tokenEstimate: HOTWORD_TOKEN_BUDGET + 1 }),
    ).toBe('deepgramGate')
  })

  it('reports the token budget only for an opted-in profile and only above the limit', () => {
    expect(
      deepgramHotwordNotice({ provider: 'deepgram', keytermsEnabled: true, tokenEstimate: HOTWORD_TOKEN_BUDGET + 1 }),
    ).toBe('deepgramTokenBudget')
    expect(
      deepgramHotwordNotice({ provider: 'deepgram', keytermsEnabled: true, tokenEstimate: HOTWORD_TOKEN_BUDGET }),
    ).toBeNull()
  })

  it('stays silent for every other provider', () => {
    for (const provider of ['groq_whisper', 'qwen', 'local', null]) {
      expect(
        deepgramHotwordNotice({ provider, keytermsEnabled: false, tokenEstimate: HOTWORD_TOKEN_BUDGET + 1 }),
      ).toBeNull()
    }
  })
})
