import { describe, it, expect } from 'vitest'
import {
  matchesModelSearch,
  filterCatalogModels,
  type FilterableModel,
} from '../modelFilter'

const mockParakeetEn: FilterableModel = {
  id: 'parakeet-unified-en-0.6b-gguf',
  name: 'Parakeet Unified English',
  description: 'Fast English model',
  languages: ['en'],
  languages_label: 'en',
  quant: 'q4_0',
  featured: true,
  speed: 5,
  accuracy: 4,
  memory_mb: 600,
}

const mockWhisperLarge: FilterableModel = {
  id: 'whisper-large-v3-gguf',
  name: 'Whisper Large v3',
  description: 'High accuracy multilingual model',
  languages: ['en', 'uk', 'ru', 'de', 'fr', 'es', 'pl'],
  languages_label: '100 languages',
  quant: 'q4_0',
  featured: true,
  speed: 3,
  accuracy: 5,
  memory_mb: 1800,
}

const mockGigaamCtc: FilterableModel = {
  id: 'gigaam-v3-e2e-ctc-gguf',
  name: 'GigaAM v3 CTC',
  description: 'Compact Russian speech model',
  languages: ['ru'],
  languages_label: 'ru',
  quant: 'q8_0',
  featured: false,
  speed: 4,
  accuracy: 4,
  memory_mb: 500,
}

const mockModels: FilterableModel[] = [mockParakeetEn, mockWhisperLarge, mockGigaamCtc]

describe('matchesModelSearch', () => {
  it('returns true for empty or whitespace query', () => {
    expect(matchesModelSearch(mockWhisperLarge, '')).toBe(true)
    expect(matchesModelSearch(mockWhisperLarge, '   ')).toBe(true)
  })

  it('matches raw model name case-insensitively', () => {
    expect(matchesModelSearch(mockWhisperLarge, 'whisper')).toBe(true)
    expect(matchesModelSearch(mockWhisperLarge, 'WHISPER')).toBe(true)
    expect(matchesModelSearch(mockWhisperLarge, 'Large v3')).toBe(true)
  })

  it('matches raw model description', () => {
    expect(matchesModelSearch(mockWhisperLarge, 'multilingual')).toBe(true)
    expect(matchesModelSearch(mockGigaamCtc, 'compact')).toBe(true)
  })

  it('matches quantization', () => {
    expect(matchesModelSearch(mockGigaamCtc, 'q8_0')).toBe(true)
    expect(matchesModelSearch(mockParakeetEn, 'q4_0')).toBe(true)
  })

  it('matches raw ISO language codes', () => {
    expect(matchesModelSearch(mockWhisperLarge, 'uk')).toBe(true)
    expect(matchesModelSearch(mockWhisperLarge, 'de')).toBe(true)
    expect(matchesModelSearch(mockParakeetEn, 'uk')).toBe(false)
  })

  it('matches localized human language names in Ukrainian', () => {
    // Whisper supports 'uk', which resolves to "Українська"
    expect(matchesModelSearch(mockWhisperLarge, 'українська', 'uk')).toBe(true)
    expect(matchesModelSearch(mockWhisperLarge, 'укр', 'uk')).toBe(true)
    // Parakeet does not support Ukrainian
    expect(matchesModelSearch(mockParakeetEn, 'українська', 'uk')).toBe(false)
  })

  it('matches cross-lingual language names in Russian and English', () => {
    // Cross-lingual search should match Russian search term for Ukrainian language
    expect(matchesModelSearch(mockWhisperLarge, 'украинский')).toBe(true)
    // Cross-lingual search should match German in English and Ukrainian
    expect(matchesModelSearch(mockWhisperLarge, 'german')).toBe(true)
    expect(matchesModelSearch(mockWhisperLarge, 'німецька')).toBe(true)
  })

  it('respects explicit target locale for localized model display name and description', () => {
    // Whisper Large v3 has locale-specific descriptions:
    // uk: "Найвища точність багатомовної транскрипції (100 мов)"
    // en: "Top-tier multilingual accuracy across 100 languages"
    expect(matchesModelSearch(mockWhisperLarge, 'точність', 'uk')).toBe(true)
    expect(matchesModelSearch(mockWhisperLarge, 'точність', 'en')).toBe(false)
    expect(matchesModelSearch(mockWhisperLarge, 'top-tier', 'en')).toBe(true)
    expect(matchesModelSearch(mockWhisperLarge, 'top-tier', 'uk')).toBe(false)
  })

  it('returns false when query does not match any field or language', () => {
    expect(matchesModelSearch(mockParakeetEn, 'nonexistent-query-xyz')).toBe(false)
    expect(matchesModelSearch(mockGigaamCtc, 'japanese')).toBe(false)
  })
})

describe('filterCatalogModels', () => {
  const downloadedIds = new Set([mockWhisperLarge.id])

  it('returns featured models and partitions more models when not filtering', () => {
    const result = filterCatalogModels({
      models: mockModels,
      downloadedIds,
      filterTab: 'all',
      searchQuery: '',
      showMore: false,
    })

    expect(result.isFiltering).toBe(false)
    expect(result.visibleModels).toEqual([mockParakeetEn, mockWhisperLarge])
    expect(result.moreCount).toBe(1) // mockGigaamCtc is non-featured
  })

  it('expands all models when showMore is true and not filtering', () => {
    const result = filterCatalogModels({
      models: mockModels,
      downloadedIds,
      filterTab: 'all',
      searchQuery: '',
      showMore: true,
    })

    expect(result.isFiltering).toBe(false)
    expect(result.visibleModels).toHaveLength(3)
    expect(result.moreCount).toBe(1)
  })

  it('filters by downloaded tab and disables partitioning', () => {
    const result = filterCatalogModels({
      models: mockModels,
      downloadedIds,
      filterTab: 'downloaded',
      searchQuery: '',
      showMore: false,
    })

    expect(result.isFiltering).toBe(true)
    expect(result.visibleModels).toEqual([mockWhisperLarge])
    expect(result.moreCount).toBe(1)
  })

  it('returns empty list when downloaded tab is active and no models are downloaded', () => {
    const result = filterCatalogModels({
      models: mockModels,
      downloadedIds: new Set(),
      filterTab: 'downloaded',
      searchQuery: '',
      showMore: false,
    })

    expect(result.isFiltering).toBe(true)
    expect(result.visibleModels).toEqual([])
    expect(result.moreCount).toBe(1)
  })

  it('filters by search query across tabs and shows all matches', () => {
    const result = filterCatalogModels({
      models: mockModels,
      downloadedIds,
      filterTab: 'all',
      searchQuery: 'GigaAM',
      showMore: false, // Even if showMore is false, search shows matching non-featured models
    })

    expect(result.isFiltering).toBe(true)
    expect(result.visibleModels).toEqual([mockGigaamCtc])
    expect(result.moreCount).toBe(1)
  })

  it('combines downloaded tab and search query', () => {
    // mockGigaamCtc is not downloaded, so search for GigaAM under downloaded tab yields 0
    const result = filterCatalogModels({
      models: mockModels,
      downloadedIds,
      filterTab: 'downloaded',
      searchQuery: 'GigaAM',
      showMore: false,
    })

    expect(result.isFiltering).toBe(true)
    expect(result.visibleModels).toEqual([])
    expect(result.moreCount).toBe(1)
  })

  it('sorts models supporting active speech language to the top', () => {
    // When badgeLanguage is 'ru', GigaAM and Whisper support 'ru', Parakeet does not
    const result = filterCatalogModels({
      models: mockModels,
      downloadedIds,
      filterTab: 'all',
      searchQuery: '',
      showMore: true,
      badgeLanguage: 'ru',
    })

    const ids = result.visibleModels.map((m) => m.id)
    expect(ids.indexOf('gigaam-v3-e2e-ctc-gguf')).toBeLessThan(ids.indexOf('parakeet-unified-en-0.6b-gguf'))
    expect(ids.indexOf('whisper-large-v3-gguf')).toBeLessThan(ids.indexOf('parakeet-unified-en-0.6b-gguf'))
  })
})
