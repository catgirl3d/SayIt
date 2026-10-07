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

import { getSetting, setSetting } from '@/services/store'
import {
  AI_PROVIDERS,
  aiSettingKey,
  migrateLegacyProfiles,
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
/** 老数据只迁一次。没有这个标记，用户删光列表后下次进页面又会被"救回来" */
export const AI_PROFILES_MIGRATED_KEY = 'cloudAi.profilesMigrated'

export interface AiProfileState {
  profiles: AiProfile[]
  activeId: string
}

/**
 * Write the active entry into the flat runtime keys. No usable profile writes empty
 * strings so downstream code skips the AI step on its own.
 *
 * Tuning values are mirrored per capability: each one only when the active provider's
 * endpoint accepts it, so switching providers never leaks a field the new endpoint would
 * reject.
 */
async function syncRuntimeActive(profile: AiProfile | null): Promise<void> {
  await Promise.all([
    setSetting('cloudAi.provider', profile?.provider ?? ''),
    setSetting('cloudAi.apiUrl', profile?.apiUrl ?? ''),
    setSetting('cloudAi.apiKey', profile?.apiKey ?? ''),
    setSetting('cloudAi.model', profile?.model ?? ''),
    setSetting(
      'cloudAi.reasoningEffort',
      profile && supportsReasoningEffort(profile.provider) ? profile.reasoningEffort ?? '' : '',
    ),
    setSetting(
      'cloudAi.serviceTier',
      profile && supportsServiceTier(profile.provider) ? profile.serviceTier ?? '' : '',
    ),
  ])
}

/** 读出老的「每供应商一组配置」。键一律不删：降级回旧版本还能用 */
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
 * 加载服务列表。首次进入会把老的按供应商存的配置摊平成列表。
 *
 * 返回前会把 activeId 归一化（指向已不存在的 id 时回落到第一条），并在确实写过东西时
 * 顺手同步运行时配置——否则会出现"列表里高亮着 A，实际在用 B"。
 */
export async function loadAiProfiles(): Promise<AiProfileState> {
  const [migrated, rawProfiles, storedActiveId] = await Promise.all([
    getSetting(AI_PROFILES_MIGRATED_KEY, false) as Promise<boolean>,
    getSetting(AI_PROFILES_KEY, [] as unknown[]) as Promise<unknown>,
    getSetting(AI_ACTIVE_PROFILE_KEY, '') as Promise<string>,
  ])

  let profiles = parseProfiles(rawProfiles)
  let activeId = storedActiveId
  let needsWrite = false

  if (!migrated) {
    // 老用户：把每家的候选模型摊平成一条条服务；新用户这里得到空列表，走空状态引导
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
    await saveAiProfiles({ profiles, activeId })
  }

  return { profiles, activeId }
}

/** 落盘列表 + 启用项，并把启用的那条同步进运行时配置。所有写路径都必须走这里 */
export async function saveAiProfiles(state: AiProfileState): Promise<void> {
  const active = resolveActiveProfile(state.profiles, state.activeId)
  await Promise.all([setSetting(AI_PROFILES_KEY, state.profiles), setSetting(AI_ACTIVE_PROFILE_KEY, active?.id ?? '')])
  await syncRuntimeActive(active)
}
