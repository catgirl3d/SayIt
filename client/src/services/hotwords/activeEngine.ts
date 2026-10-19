import { loadActiveAsrProfile } from '@/features/settings/asrProfileStore'
import { findAsrProvider, resolveAsrDispatchProvider } from '@/features/settings/asrProviderCatalog'
import { getWorkMode } from '@/services/transcription'
import type { WorkMode } from '@/services/transcription/types'

export interface DictationHotwordEngine {
  mode: WorkMode
  /** Key into the Rust hotword capability matrix for the engine dictation uses right now. */
  capabilityKey: string
  /** Catalog label of the active cloud provider; empty for the server and local modes. */
  providerLabel: string
  /** Whether the active profile opted in to sending hotwords to Deepgram; false for every other engine. */
  deepgramKeytermsEnabled: boolean
}

/**
 * Resolves the engine dictation uses into a capability-matrix key. The work mode is the one the
 * recorder runs with (`getWorkMode`, initialized from the store before the UI renders), so the
 * answer cannot disagree with what dictation actually does.
 * Returns null in Cloud API mode while no ASR service is configured, so no verdict is claimed.
 */
export async function loadDictationHotwordEngine(): Promise<DictationHotwordEngine | null> {
  const mode = getWorkMode()
  if (mode !== 'cloud_api') {
    return { mode, capabilityKey: mode === 'local' ? 'local' : 'server', providerLabel: '', deepgramKeytermsEnabled: false }
  }

  const profile = await loadActiveAsrProfile()
  if (!profile) return null
  return {
    mode,
    // Every Qwen Omni variant shares the single `qwen_omni` entry in the matrix.
    capabilityKey: resolveAsrDispatchProvider(profile.provider),
    providerLabel: findAsrProvider(profile.provider)?.label ?? profile.provider,
    deepgramKeytermsEnabled: profile.deepgramKeytermsEnabled === true,
  }
}
