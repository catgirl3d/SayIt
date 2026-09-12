import type { SpeechInputLanguage } from '@/services/speechInputLanguage'
import { getLocale } from '@/i18n'
import {
  localModelDisplayDescription,
  localModelDisplayLanguages,
  localModelDisplayName,
} from '@/i18n/displayNames'
import { getLanguageDisplayName } from '@/lib/languageNames'
import { sortModelsBySpeechLanguageSupport } from '@/lib/asrModels'

export type ModelFilterTab = 'all' | 'downloaded'

const SEARCH_LOCALES = ['uk', 'ru', 'en'] as const

export interface FilterableModel {
  id: string
  name: string
  description?: string
  total_size_bytes?: number
  languages?: string[]
  languages_label?: string
  quant?: string
  featured?: boolean
  speed?: number
  accuracy?: number
  memory_mb?: number
}

/**
 * Checks whether a model matches the search query string.
 *
 * Matching rules:
 * - Localized model name and description in the active UI locale.
 * - Raw catalog model name and description.
 * - Quantization tier (e.g. 'q4', 'q8') and language display label.
 * - Language tags: expands ISO-639 codes into localized language names across
 *   common search locales (UK, RU, EN) and matches raw ISO codes directly.
 */
export function matchesModelSearch(
  model: FilterableModel,
  query: string,
  locale: string = getLocale(),
): boolean {
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) return true

  const name = localModelDisplayName(model, locale).toLowerCase()
  const origName = model.name.toLowerCase()
  const desc = localModelDisplayDescription(model, locale).toLowerCase()
  const origDesc = (model.description || '').toLowerCase()
  const langLabel = localModelDisplayLanguages(model, locale).toLowerCase()
  const origLangLabel = (model.languages_label || '').toLowerCase()
  const quant = (model.quant || '').toLowerCase()

  if (
    name.includes(trimmed) ||
    origName.includes(trimmed) ||
    desc.includes(trimmed) ||
    origDesc.includes(trimmed) ||
    langLabel.includes(trimmed) ||
    origLangLabel.includes(trimmed) ||
    quant.includes(trimmed)
  ) {
    return true
  }

  if (model.languages && model.languages.length > 0) {
    return model.languages.some((code) => {
      const norm = code.toLowerCase()
      if (norm.includes(trimmed)) return true

      // Check in the active UI locale
      const nameInCurrent = getLanguageDisplayName(norm, locale).toLowerCase()
      if (nameInCurrent.includes(trimmed)) return true

      // Cross-lingual search across UK, RU, EN aliases
      return SEARCH_LOCALES.some((searchLocale) => {
        if (searchLocale === locale) return false
        const localizedName = getLanguageDisplayName(norm, searchLocale).toLowerCase()
        return localizedName.includes(trimmed)
      })
    })
  }

  return false
}

export interface FilterCatalogOptions<T extends FilterableModel> {
  models: readonly T[]
  downloadedIds: ReadonlySet<string>
  filterTab: ModelFilterTab
  searchQuery: string
  showMore: boolean
  badgeLanguage?: Exclude<SpeechInputLanguage, 'auto'>
  locale?: string
  isRecommended?: (modelId: string) => boolean
}

export interface FilterCatalogResult<T> {
  visibleModels: T[]
  moreCount: number
  isFiltering: boolean
}

/**
 * Pure catalog filtering and partitioning logic (Single Source of Truth):
 * 1. Partitions catalog into featured and more models.
 * 2. Filters by tab ('all' vs 'downloaded').
 * 3. Applies multi-language search matching.
 * 4. Preserves featured + showMore collapse logic when not searching/filtering.
 * 5. Sorts by speech-language compatibility and language recommendations.
 * 6. Returns visibleModels along with moreCount and isFiltering state.
 */
export function filterCatalogModels<T extends FilterableModel>({
  models,
  downloadedIds,
  filterTab,
  searchQuery,
  showMore,
  badgeLanguage,
  locale = getLocale(),
  isRecommended,
}: FilterCatalogOptions<T>): FilterCatalogResult<T> {
  const trimmed = searchQuery.trim().toLowerCase()
  const isFiltering = filterTab === 'downloaded' || trimmed !== ''

  const featuredModels = models.some((m) => m.featured)
    ? models.filter((m) => m.featured)
    : models
  const moreModels = models.filter((m) => !featuredModels.includes(m))
  const moreCount = moreModels.length

  const baseModels = isFiltering
    ? (filterTab === 'downloaded'
        ? models.filter((m) => downloadedIds.has(m.id))
        : models)
    : (showMore ? [...featuredModels, ...moreModels] : featuredModels)

  const filtered = trimmed
    ? baseModels.filter((m) => matchesModelSearch(m, trimmed, locale))
    : baseModels

  const sorted = badgeLanguage
    ? sortModelsBySpeechLanguageSupport(filtered, badgeLanguage)
    : [...filtered]

  const visibleModels = isRecommended
    ? [...sorted].sort((a, b) => {
        const aRec = isRecommended(a.id) ? 1 : 0
        const bRec = isRecommended(b.id) ? 1 : 0
        return bRec - aRec
      })
    : sorted

  return {
    visibleModels,
    moreCount,
    isFiltering,
  }
}
