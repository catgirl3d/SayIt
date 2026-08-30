import { describe, expect, it } from 'vitest'
import { RecorderOrchestrator } from '../RecorderOrchestrator'

function cachedLanguage(recorder: RecorderOrchestrator): string {
  return (recorder as unknown as { cachedLanguage: string }).cachedLanguage
}

describe('server recognition language cache', () => {
  it('updates the next recording language without a full settings refresh', () => {
    const recorder = new RecorderOrchestrator()

    recorder.setServerLanguageCache('ru')

    expect(cachedLanguage(recorder)).toBe('ru')
  })

  it('keeps auto represented as an omitted language override', () => {
    const recorder = new RecorderOrchestrator()

    recorder.setServerLanguageCache('ru')
    recorder.setServerLanguageCache('auto')

    expect(cachedLanguage(recorder)).toBe('')
  })
})
