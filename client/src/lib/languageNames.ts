import { getLocale } from '@/i18n'

/**
 * Custom overrides for language/dialect codes that standard Intl.DisplayNames
 * may not format idiomatically or across all locales.
 */
const SPECIAL_LANGUAGE_NAMES: Record<string, Record<string, string>> = {
  yue: {
    uk: 'Кантонська',
    en: 'Cantonese',
    ru: 'Кантонский',
  },
  fil: {
    uk: 'Філіппінська',
    en: 'Filipino',
    ru: 'Филиппинский',
  },
  jw: {
    uk: 'Яванська',
    en: 'Javanese',
    ru: 'Яванский',
  },
  nb: {
    uk: 'Норвезька (букмол)',
    en: 'Norwegian Bokmål',
    ru: 'Норвежский букмол',
  },
  nn: {
    uk: 'Новонорвезька (нюношк)',
    en: 'Norwegian Nynorsk',
    ru: 'Новонорвежский',
  },
}

const DISPLAY_NAMES_BY_LOCALE = new Map<string, Intl.DisplayNames>()

/**
 * Returns a human-readable, capitalized display name for an ISO-639-1 / BCP-47
 * language code in the current or specified UI locale.
 */
export function getLanguageDisplayName(code: string, locale = getLocale()): string {
  const norm = code.toLowerCase().trim()
  if (!norm) return ''

  if (SPECIAL_LANGUAGE_NAMES[norm]?.[locale]) {
    return SPECIAL_LANGUAGE_NAMES[norm][locale]
  }
  if (SPECIAL_LANGUAGE_NAMES[norm]?.en) {
    return SPECIAL_LANGUAGE_NAMES[norm].en
  }

  try {
    let displayNames = DISPLAY_NAMES_BY_LOCALE.get(locale)
    if (!displayNames) {
      displayNames = new Intl.DisplayNames([locale, 'en'], { type: 'language' })
      DISPLAY_NAMES_BY_LOCALE.set(locale, displayNames)
    }
    const name = displayNames.of(norm)
    if (name) {
      return name.charAt(0).toUpperCase() + name.slice(1)
    }
  } catch {
    // Fallback if language code is not recognized by the runtime
  }

  return norm.toUpperCase()
}

export interface ResolvedLanguageItem {
  code: string
  name: string
  isCurrent: boolean
}

/**
 * Resolves an array of language codes to their localized display names,
 * placing the active speech input language first, followed by alphabetical order.
 */
export function resolveModelLanguages(
  codes: readonly string[] | undefined | null,
  currentLanguageCode?: string,
  locale = getLocale(),
): ResolvedLanguageItem[] {
  if (!codes || codes.length === 0) return []
  const currentNorm = currentLanguageCode?.toLowerCase().trim()

  const items: ResolvedLanguageItem[] = codes.map((code) => {
    const norm = code.toLowerCase().trim()
    return {
      code: norm,
      name: getLanguageDisplayName(norm, locale),
      isCurrent: Boolean(currentNorm && norm === currentNorm),
    }
  })

  return items.sort((a, b) => {
    if (a.isCurrent && !b.isCurrent) return -1
    if (!a.isCurrent && b.isCurrent) return 1
    return a.name.localeCompare(b.name, locale)
  })
}
