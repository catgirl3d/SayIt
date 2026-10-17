// Selection-edit service resolution: one saved AI service can be dedicated to editing
// selected text (rewrite, translate, ask) instead of the active dictation service.
//
// The snapshot is request-only state captured at recording start: profile edits or deletions
// during an in-flight run must not change what that run uses, and the API key inside must
// never be persisted to history, diagnostics or logs. The list is read through the queued
// profile store, so this module can never observe a half-written service list.

import type { AiProfile } from '@/features/settings/aiProviderCatalog'
import { loadAiProfiles } from '@/features/settings/aiProfileStore'
import type { TextContext } from '@/types/appContext'
import { addRuntimeEvent } from '../debugLog'
import { getSetting } from '../store'

export const CONTEXT_SELECTION_AI_PROFILE_KEY = 'contextSelectionAiProfileId'

/** Request-only configuration frozen at recording start. Never persist or log this snapshot. */
export type SelectionAiConfig = Pick<
  AiProfile,
  'provider' | 'apiUrl' | 'apiKey' | 'model' | 'reasoningEffort' | 'serviceTier'
>

/**
 * Resolve once at recording start so profile edits cannot change an in-flight request.
 * Returns null when no service is chosen, when there is no usable selection, or when the
 * saved service cannot be found — in all those cases the caller uses the dictation model.
 */
export async function loadSelectionAiConfig(
  textContext: TextContext | null | undefined,
): Promise<SelectionAiConfig | null> {
  if (!textContext?.selectedText || textContext.selectionTruncated) return null
  try {
    const profileId = await getSetting(CONTEXT_SELECTION_AI_PROFILE_KEY, '')
    if (!profileId) return null
    const { profiles } = await loadAiProfiles()
    const profile = profiles.find((item) => item.id === profileId)
    if (!profile) {
      addRuntimeEvent('warn', 'ai', 'Selection-edit service is unavailable; using the dictation model')
      return null
    }
    const { provider, apiUrl, apiKey, model, reasoningEffort, serviceTier } = profile
    return { provider, apiUrl, apiKey, model, reasoningEffort, serviceTier }
  } catch {
    addRuntimeEvent('warn', 'ai', 'Could not resolve the selection-edit service; using the dictation model')
    return null
  }
}
