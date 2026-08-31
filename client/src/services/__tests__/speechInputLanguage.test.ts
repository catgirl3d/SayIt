import { beforeEach, describe, expect, it, vi } from 'vitest'

const bridgeState = vi.hoisted(() => ({ values: new Map<string, unknown>() }))
vi.mock('@/services/bridge', () => ({
  storeGet: vi.fn(async (key: string) => bridgeState.values.get(key) ?? null),
  storeSet: vi.fn(async (key: string, value: unknown) => { bridgeState.values.set(key, value) }),
}))

import { initSpeechInputLanguageMigration, normalizeSpeechInputLanguage } from '../speechInputLanguage'

describe('speech input language', () => {
  beforeEach(() => bridgeState.values.clear())
  it('normalizes only the supported five values', () => {
    for (const value of ['auto', 'ru', 'uk', 'en', 'zh']) expect(normalizeSpeechInputLanguage(value)).toBe(value)
    for (const value of ['ja', 'ko', 'RU', '', undefined, null, {}, 1]) expect(normalizeSpeechInputLanguage(value)).toBe('auto')
  })
  it('migrates local and server legacy values and remains idempotent', async () => {
    bridgeState.values.set('workMode', 'local')
    bridgeState.values.set('localAsr.language', 'ru')
    await initSpeechInputLanguageMigration()
    expect(bridgeState.values.get('speechInput.language')).toBe('ru')
    bridgeState.values.set('localAsr.language', 'uk')
    await initSpeechInputLanguageMigration()
    expect(bridgeState.values.get('speechInput.language')).toBe('ru')
    bridgeState.values.clear()
    bridgeState.values.set('workMode', 'server')
    bridgeState.values.set('server.language', 'uk')
    await initSpeechInputLanguageMigration()
    expect(bridgeState.values.get('speechInput.language')).toBe('uk')
  })
  it('defaults cloud, missing, and unsupported legacy values to auto', async () => {
    bridgeState.values.set('workMode', 'cloud_api')
    bridgeState.values.set('localAsr.language', 'ja')
    await initSpeechInputLanguageMigration()
    expect(bridgeState.values.get('speechInput.language')).toBe('auto')
  })
  it('normalizes invalid existing values but never overwrites valid ones', async () => {
    bridgeState.values.set('speechInput.language', 'ja')
    bridgeState.values.set('workMode', 'server')
    bridgeState.values.set('server.language', 'ru')
    await initSpeechInputLanguageMigration()
    expect(bridgeState.values.get('speechInput.language')).toBe('auto')
    bridgeState.values.set('speechInput.language', 'en')
    bridgeState.values.set('server.language', 'uk')
    await initSpeechInputLanguageMigration()
    expect(bridgeState.values.get('speechInput.language')).toBe('en')
  })
})
