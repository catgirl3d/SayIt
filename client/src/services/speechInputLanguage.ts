import * as bridge from './bridge'
import { getSetting, setSetting } from './store'

export type SpeechInputLanguage = 'auto' | 'ru' | 'uk' | 'en' | 'zh'

export const SPEECH_INPUT_LANGUAGES = ['auto', 'ru', 'uk', 'en', 'zh'] as const

export function normalizeSpeechInputLanguage(value: unknown): SpeechInputLanguage {
  return typeof value === 'string' && (SPEECH_INPUT_LANGUAGES as readonly string[]).includes(value)
    ? value as SpeechInputLanguage
    : 'auto'
}

export async function getSpeechInputLanguage(): Promise<SpeechInputLanguage> {
  return normalizeSpeechInputLanguage(await getSetting('speechInput.language', 'auto'))
}

export async function setSpeechInputLanguage(language: SpeechInputLanguage): Promise<void> {
  await setSetting('speechInput.language', normalizeSpeechInputLanguage(language))
}

export async function initSpeechInputLanguageMigration(): Promise<void> {
  const existing = await bridge.storeGet('speechInput.language')
  if (existing !== null && existing !== undefined) {
    if (normalizeSpeechInputLanguage(existing) !== existing) {
      await bridge.storeSet('speechInput.language', normalizeSpeechInputLanguage(existing))
    }
    return
  }

  const workMode = await bridge.storeGet('workMode')
  let legacyLanguage: unknown
  if (workMode === 'local') legacyLanguage = await bridge.storeGet('localAsr.language')
  if (workMode === 'server') legacyLanguage = await bridge.storeGet('server.language')
  await bridge.storeSet('speechInput.language', normalizeSpeechInputLanguage(legacyLanguage))
}

export function getSpeechLanguageEnglishName(lang: SpeechInputLanguage): 'Russian' | 'Ukrainian' | 'English' | 'Chinese' | null {
  switch (lang) {
    case 'ru': return 'Russian'
    case 'uk': return 'Ukrainian'
    case 'en': return 'English'
    case 'zh': return 'Chinese'
    default: return null
  }
}

export function applySpeechLanguageToPrompt(
  preset: { builtin?: boolean; id: string },
  lang: SpeechInputLanguage,
): string | null {
  if (!preset.builtin || !['intent', 'faithful', 'casual'].includes(preset.id) || lang === 'auto') return null
  const name = getSpeechLanguageEnglishName(lang)
  if (!name) return null
  return `Speech language: the speaker dictated primarily in ${name}. Treat it as the expected transcript language: fix recognition errors against it and return the cleaned transcript in the same language; never translate it.`
}
