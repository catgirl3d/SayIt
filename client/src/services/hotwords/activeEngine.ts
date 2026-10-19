import { loadActiveAsrProfile } from '@/features/settings/asrProfileStore'
import { findAsrProvider, resolveAsrDispatchProvider } from '@/features/settings/asrProviderCatalog'
import { getSetting } from '@/services/store'

export type DictationEngineMode = 'server' | 'cloud_api' | 'local'

export interface DictationHotwordEngine {
  mode: DictationEngineMode
  /** Key into the Rust hotword capability matrix for the engine dictation uses right now. */
  capabilityKey: string
  /** Catalog label of the active cloud provider; empty for the server and local modes. */
  providerLabel: string
}

/**
 * Resolves the engine dictation uses into a capability-matrix key, mirroring how the sidebar
 * mode status reads the stored work mode: anything other than local / cloud_api is server mode.
 * Returns null in Cloud API mode while no ASR service is configured, so no verdict is claimed.
 */
export async function loadDictationHotwordEngine(): Promise<DictationHotwordEngine | null> {
  const stored = await getSetting<string>('workMode', 'server')
  if (stored === 'local') return { mode: 'local', capabilityKey: 'local', providerLabel: '' }
  if (stored !== 'cloud_api') return { mode: 'server', capabilityKey: 'server', providerLabel: '' }

  const profile = await loadActiveAsrProfile()
  if (!profile) return null
  return {
    mode: 'cloud_api',
    // Every Qwen Omni variant shares the single `qwen_omni` entry in the matrix.
    capabilityKey: resolveAsrDispatchProvider(profile.provider),
    providerLabel: findAsrProvider(profile.provider)?.label ?? profile.provider,
  }
}
