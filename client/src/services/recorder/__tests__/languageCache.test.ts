import { describe, expect, it } from 'vitest'
import { RecorderOrchestrator } from '../RecorderOrchestrator'

function cachedLanguage(recorder: RecorderOrchestrator): string {
  return (recorder as unknown as { cachedLanguage: string }).cachedLanguage
}

describe('speech language cache', () => {
  it('updates the next recording language without a full settings refresh', () => {
    const recorder = new RecorderOrchestrator()

    recorder.setSpeechLanguageCache('ru')

    expect(cachedLanguage(recorder)).toBe('ru')
  })

  it('keeps auto as an explicit snapshot value', () => {
    const recorder = new RecorderOrchestrator()

    recorder.setSpeechLanguageCache('ru')
    recorder.setSpeechLanguageCache('auto')

    expect(cachedLanguage(recorder)).toBe('auto')
  })
})
