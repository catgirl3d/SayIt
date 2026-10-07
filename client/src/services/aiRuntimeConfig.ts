// Runtime AI settings assembled from the flat `cloudAi.*` keys.
//
// The AI Services page mirrors the active profile into these keys (see aiProfileStore)
// and every runtime consumer — the recording pipeline, history re-runs, the diagnostics
// page — reads them here. buildAiProviderConfig maps these settings to the native request
// shape so tuning and core fields stay aligned across callers.

import { getSetting } from './store'

export interface RuntimeAiConfig {
  provider: string
  apiUrl: string
  apiKey: string
  model: string
  /**
   * OpenAI-only request tuning values. The request builder omits them for other
   * providers and when no value is set.
   */
  reasoningEffort: string
  serviceTier: string
}

export async function loadRuntimeAiConfig(): Promise<RuntimeAiConfig> {
  const [provider, apiUrl, apiKey, model, reasoningEffort, serviceTier] = await Promise.all([
    getSetting('cloudAi.provider', 'openai_compat') as Promise<string>,
    getSetting('cloudAi.apiUrl', '') as Promise<string>,
    getSetting('cloudAi.apiKey', '') as Promise<string>,
    getSetting('cloudAi.model', '') as Promise<string>,
    getSetting('cloudAi.reasoningEffort', '') as Promise<string>,
    getSetting('cloudAi.serviceTier', '') as Promise<string>,
  ])
  return {
    provider,
    apiUrl,
    apiKey,
    model,
    reasoningEffort,
    serviceTier,
  }
}
