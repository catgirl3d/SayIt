// Persistence for the AI Services list and its synchronization into the runtime settings.
//
// Two sets of keys with strictly separate responsibilities:
//   1. The list itself — `cloudAi.profiles` + `cloudAi.activeProfileId`; only this page reads them.
//   2. The runtime copy — `cloudAi.provider / apiUrl / apiKey / model` plus the OpenAI-only
//      `cloudAi.reasoningEffort / serviceTier` tuning. It is consumed by the recording pipeline
//      (CloudAPIProvider, LocalProvider), history re-runs, the diagnostics page, and feedback
//      reporting. Those consumers read only these flat keys; **the contract must not change shape**.
//
// The rule: the list is the truth; every list or active-profile change writes the whole active
// entry into the flat keys. The historical "model switched but URL/key still belong to the
// previous provider" bug existed because those keys used to be maintained separately; now they
// have exactly one writer.
//
// Profiles include API keys and are included in full configuration exports. Public support bundles
// use an explicit categorical environment contract and never include cloudAi settings.

import { getSetting, setSetting, setSettings } from '@/services/store'
import {
  AI_PROVIDERS,
  aiSettingKey,
  migrateLegacyProfiles,
  normalizeProfiles,
  parseLegacyLatencies,
  parseProfiles,
  resolveActiveProfile,
  supportsReasoningEffort,
  supportsServiceTier,
  type AiProfile,
  type LegacyProviderData,
} from './aiProviderCatalog'

export const AI_PROFILES_KEY = 'cloudAi.profiles'
export const AI_ACTIVE_PROFILE_KEY = 'cloudAi.activeProfileId'
/** Legacy data is migrated once. Without this marker, an emptied list would be "rescued" on the next visit. */
export const AI_PROFILES_MIGRATED_KEY = 'cloudAi.profilesMigrated'

export interface AiProfileState {
  profiles: AiProfile[]
  activeId: string
}

// Each save commits one atomic batch. Keep reads, migrations and saves ordered so a
// profile read waits for the preceding save before deriving a normalized selection.
let profileOperationQueue: Promise<void> = Promise.resolve()

function enqueueProfileRead<T>(operation: () => Promise<T>): Promise<T> {
  const result = profileOperationQueue.then(operation)
  profileOperationQueue = result.then(() => undefined, () => undefined)
  return result
}

function enqueueProfileSave<T>(operation: () => Promise<T>): Promise<T> {
  const result = profileOperationQueue.then(operation, operation)
  profileOperationQueue = result.then(() => undefined, () => undefined)
  return result
}

/** Read the legacy per-provider config groups. Keys are never deleted so a downgrade still works. */
async function readLegacyData(): Promise<LegacyProviderData[]> {
  return Promise.all(
    AI_PROVIDERS.map(async (provider): Promise<LegacyProviderData> => {
      const [apiUrl, apiKey, model, modelsRaw, latencyRaw] = await Promise.all([
        getSetting(aiSettingKey(provider.value, 'apiUrl'), '') as Promise<string>,
        getSetting(aiSettingKey(provider.value, 'apiKey'), '') as Promise<string>,
        getSetting(aiSettingKey(provider.value, 'model'), '') as Promise<string>,
        getSetting(aiSettingKey(provider.value, 'models'), '') as Promise<string>,
        getSetting(aiSettingKey(provider.value, 'latency'), '') as Promise<string>,
      ])
      return {
        provider: provider.value,
        apiUrl,
        apiKey,
        model,
        models: modelsRaw
          ? modelsRaw
              .split(',')
              .map((m) => m.trim())
              .filter(Boolean)
          : [],
        latencies: parseLegacyLatencies(latencyRaw),
      }
    }),
  )
}

/**
 * Load the service list. On first visit, legacy per-provider configs are flattened into
 * the list.
 *
 * Before returning, activeId is normalized (falls back to the first entry when it points
 * at a missing id), and the runtime settings are mirrored whenever something was actually
 * written — otherwise the list would highlight A while B is the profile in use.
 */
async function loadAiProfilesUnlocked(): Promise<AiProfileState> {
  const [migrated, rawProfiles, storedActiveId] = await Promise.all([
    getSetting(AI_PROFILES_MIGRATED_KEY, false) as Promise<boolean>,
    getSetting(AI_PROFILES_KEY, [] as unknown[]) as Promise<unknown>,
    getSetting(AI_ACTIVE_PROFILE_KEY, '') as Promise<string>,
  ])

  const parsedProfiles = parseProfiles(rawProfiles)
  let profiles = normalizeProfiles(parsedProfiles)
  let activeId = storedActiveId
  // Normalized entries (and their runtime mirror) must be written back, not just
  // shown: the flat keys are what the recording pipeline reads.
  let needsWrite = profiles !== parsedProfiles

  if (!migrated) {
    // Existing users: flatten each provider's candidate models into individual services;
    // new users get an empty list and the empty-state guide.
    if (profiles.length === 0) {
      const [legacy, legacyProvider, legacyModel] = await Promise.all([
        readLegacyData(),
        getSetting('cloudAi.provider', '') as Promise<string>,
        getSetting('cloudAi.model', '') as Promise<string>,
      ])
      const result = migrateLegacyProfiles(legacy, legacyProvider, legacyModel)
      profiles = result.profiles
      activeId = result.activeId
    }
    await setSetting(AI_PROFILES_MIGRATED_KEY, true)
    needsWrite = profiles.length > 0
  }

  const active = resolveActiveProfile(profiles, activeId)
  if (active && active.id !== activeId) {
    activeId = active.id
    needsWrite = true
  }
  if (!active && activeId !== '') {
    activeId = ''
    needsWrite = true
  }

  if (needsWrite) {
    await saveAiProfilesUnlocked({ profiles, activeId })
  }

  return { profiles, activeId }
}

/** Enqueued read: waits for any in-flight save, so callers never observe a half-written list. */
export function loadAiProfiles(): Promise<AiProfileState> {
  return enqueueProfileRead(loadAiProfilesUnlocked)
}

/**
 * Commit the list, selection and runtime mirror together. No profile clears the runtime
 * keys so downstream code skips AI. Tuning is mirrored only when the selected endpoint
 * accepts it, preventing a provider switch from leaking fields the new endpoint rejects.
 */
async function saveAiProfilesUnlocked(state: AiProfileState): Promise<void> {
  const active = resolveActiveProfile(state.profiles, state.activeId)
  await setSettings({
    [AI_PROFILES_KEY]: state.profiles,
    [AI_ACTIVE_PROFILE_KEY]: active?.id ?? '',
    'cloudAi.provider': active?.provider ?? '',
    'cloudAi.apiUrl': active?.apiUrl ?? '',
    'cloudAi.apiKey': active?.apiKey ?? '',
    'cloudAi.model': active?.model ?? '',
    'cloudAi.reasoningEffort': active && supportsReasoningEffort(active.provider) ? active.reasoningEffort ?? '' : '',
    'cloudAi.serviceTier': active && supportsServiceTier(active.provider) ? active.serviceTier ?? '' : '',
  })
  // Settings UIs (for example the selection-edit model picker) refresh their list on this.
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('ai-profiles-changed'))
}

/** Every write path must go through here; the call is serialized with all other profile operations. */
export function saveAiProfiles(state: AiProfileState): Promise<void> {
  return enqueueProfileSave(() => saveAiProfilesUnlocked(state))
}
