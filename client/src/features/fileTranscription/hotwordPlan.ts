import type { FoldedHotwordDelivery } from '@/lib/asrModels'
import type { FileTranscriptionEngine } from '@/services/fileTranscription'
import { estimateHotwordTokens } from '@/services/hotwords/budget'
import { deepgramHotwordNotice, type DeepgramHotwordNotice } from '@/services/hotwords/deepgramNotice'
import { composeSelectedHotwords } from '@/services/hotwords/model'
import type { HotwordCatalog } from '@/services/hotwords/settings'

export type HotwordMode = 'active' | 'selected' | 'none'

export interface HotwordCategorySelection {
  builtinKeys: string[]
  themeIds: string[]
}

type HotwordNotice = DeepgramHotwordNotice | 'wordCap'

export interface HotwordPlan {
  /** Whether this engine and provider use hotwords at all; the control is hidden otherwise. */
  applicable: boolean
  hotwords: string[]
  tokenEstimate: number
  wordCount: number
  wordCapLimit: number | null
  notices: HotwordNotice[]
}

interface HotwordPlanInput {
  mode: HotwordMode
  selection: HotwordCategorySelection
  catalog: HotwordCatalog | null
  engine: FileTranscriptionEngine
  provider: string | null
  /** Folded delivery verdict for the selected provider; null while unknown or not loaded. */
  providerDelivery: FoldedHotwordDelivery | null
  providerClientCap: number | null
  deepgramKeytermsEnabled: boolean
}

/**
 * Resolves what one file job sends: the active hotword list, an explicit category selection, or
 * nothing. The plan also names conditions under which the words will not reach the provider,
 * so the page can state the outcome instead of implying the dictionary is applied.
 *
 * The engine and provider decide whether hotwords exist for this job at all. When they do
 * not send them, the plan reports `applicable: false` and an empty list, and the page hides the
 * control instead of offering words that cannot take effect.
 */
export function buildHotwordPlan({
  mode,
  selection,
  catalog,
  engine,
  provider,
  providerDelivery,
  providerClientCap,
  deepgramKeytermsEnabled,
}: HotwordPlanInput): HotwordPlan {
  const applicable = engine === 'cloud' && providerDelivery === 'sent'
  if (!applicable) {
    // The control is hidden for a non-applicable plan, so no cap notice can render either.
    return { applicable: false, hotwords: [], tokenEstimate: 0, wordCount: 0, wordCapLimit: null, notices: [] }
  }

  const hotwords = !catalog || mode === 'none'
    ? []
    : mode === 'active'
      ? catalog.activeWords
      : composeSelectedHotwords(
          catalog.builtinSetWords,
          selection.builtinKeys,
          catalog.customThemes,
          selection.themeIds,
        )
  const tokenEstimate = estimateHotwordTokens(hotwords)
  const wordCount = hotwords.length
  const notices: HotwordNotice[] = []

  if (wordCount > 0) {
    const deepgramNotice = deepgramHotwordNotice({
      provider,
      keytermsEnabled: deepgramKeytermsEnabled,
      tokenEstimate,
    })
    if (deepgramNotice) notices.push(deepgramNotice)
  }
  if (providerClientCap !== null && wordCount > providerClientCap) notices.push('wordCap')

  return { applicable, hotwords, tokenEstimate, wordCount, wordCapLimit: providerClientCap, notices }
}
