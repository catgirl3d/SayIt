// The data model and pure functions for the "AI providers" page.
//
// Why this lives in its own file: every entry here has drifted, or could silently drift (defaults that disagree with examples, key-length assertions that went stale, legacy data migration),
// and all of it is pure logic, which is worth locking down with tests. The component only handles rendering and side effects.

/**
 * Provider catalog: the single source of truth.
 *
 * Default URLs and candidate models used to live in three separate tables (DEFAULT_URLS / DEFAULT_MODELS / DEFAULT_MODEL_LISTS),
 * declared inside the component function body. As a result, the same provider drifted between its example text and its defaults:
 * Qwen's example wrote `qwen-plus` while the value actually seeded was `qwen3.6-flash`,
 * MiMo's example wrote `mimo-v2.5-pro` while the default selection was `mimo-v2.5`.
 * Merging everything into one table means examples are derived directly from defaultModels[0], so this drift can no longer happen.
 */
import { getLocale, t } from '@/i18n'

/** Where a provider is based; groups the provider dropdown of the service editor. */
export type AiProviderRegion = 'global' | 'china' | 'local_custom'

export interface AiProvider {
  value: string
  /**
   * Display name. Brand names use the official English spelling (Qwen / Doubao (Volcengine Ark) / Xiaomi MiMo),
   * not a literal translation. Chinese-language UI usually calls Qwen "Tongyi Qianwen", so it must still follow the interface language.
   *
   * Note: several entries below use a **getter**, not a plain string field. Reason: this table is a module-level constant, and
   * a plain field would freeze the language active at the moment the module loads, so it would never change after a language switch. A getter
   * keeps the `.label` read syntax, so the twenty-odd call sites and three test files need no changes.
   */
  label: string
  /**
   * Dropdown group. `china` is the vendor's home market (DeepSeek included, although its API is
   * reachable internationally); `local_custom` is a self-hosted or user-supplied endpoint.
   */
  region: AiProviderRegion
  defaultUrl: string
  /**
   * A blank URL means "use the official endpoint" for this provider.
   *
   * Only a provider whose endpoint is defined in this catalog can make that
   * promise: a blank field must not silently disable saving, testing, or model
   * loading, and every path resolves it through effectiveApiUrl().
   */
  urlOptional?: boolean
  /**
   * Example model ids for this provider. The first one is the placeholder of the editor's model
   * field and the seed of blankProfile(); a new editor draft does not select it (see newDraftProfile),
   * so an outdated id here costs a stale hint, never a saved card.
   */
  defaultModels: string[]
  /**
   * Models the editor offers as one-click picks, in the order given. Unlike `defaultModels` this is a
   * deliberate recommendation, set only by presets whose catalog we curate (model ids are provider
   * specific, so a list is never shared between presets).
   */
  recommendedModels?: string[]
  /** No API key required (currently only local Ollama) */
  keyless?: boolean
  /** Console URL for obtaining a key */
  consoleUrl?: string
  /** Catalog-driven "Recommended" mark shown in the help dialog */
  recommended?: boolean
}

export const AI_PROVIDERS: AiProvider[] = [
  {
    value: 'deepseek',
    label: 'DeepSeek',
    region: 'china',
    defaultUrl: 'https://api.deepseek.com',
    defaultModels: ['deepseek-v4-flash'],
    consoleUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    value: 'qwen',
    get label() { return t('aiProvider.qwen') },
    region: 'china',
    defaultUrl: 'https://dashscope.aliyuncs.com/compatible-mode',
    defaultModels: ['qwen3.6-flash', 'qwen-plus'],
    consoleUrl: 'https://bailian.console.aliyun.com',
  },
  {
    value: 'doubao',
    get label() { return t('aiProvider.doubao') },
    region: 'china',
    defaultUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultModels: ['doubao-seed-2-0-lite-260215'],
    consoleUrl: 'https://console.volcengine.com/ark',
  },
  {
    value: 'mimo',
    get label() { return t('aiProvider.mimo') },
    region: 'china',
    defaultUrl: 'https://api.xiaomimimo.com/v1',
    defaultModels: ['mimo-v2.5', 'mimo-v2.5-pro'],
  },
  {
    value: 'groq',
    // Brand name, written Groq in every locale — no locale key needed (same handling as DeepSeek).
    label: 'Groq',
    region: 'global',
    // The last segment is already /v1, so normalize_base_url keeps it as-is and does not append a version segment.
    defaultUrl: 'https://api.groq.com/openai/v1',
    defaultModels: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'llama-3.3-70b-versatile'],
    consoleUrl: 'https://console.groq.com/keys',
    // Free tier is generous enough to run cleanup daily, so the help marks it as the
    // recommended starting point for users who have no provider configured yet.
    recommended: true,
  },
  {
    value: 'opencode_go',
    // Brand name, identical in every locale (same handling as DeepSeek and Groq).
    label: 'OpenCode Go',
    region: 'global',
    // Rust appends /chat/completions: -> https://opencode.ai/zen/go/v1/chat/completions
    defaultUrl: 'https://opencode.ai/zen/go/v1',
    defaultModels: ['deepseek-v4.1-flash', 'glm-5.3-flash', 'kimi-k2.6'],
    consoleUrl: 'https://opencode.ai/auth',
  },
  {
    value: 'openrouter',
    // Brand name, identical in every locale (same handling as DeepSeek and Groq).
    label: 'OpenRouter',
    region: 'global',
    // Rust appends /chat/completions and derives /models from it for the model list.
    defaultUrl: 'https://openrouter.ai/api/v1',
    // The only provider that accepts a blank URL: the field starts prefilled, and
    // clearing it means "use the official endpoint" instead of blocking the save.
    urlOptional: true,
    defaultModels: ['deepseek/deepseek-v4.1-flash'],
    recommendedModels: ['deepseek/deepseek-v4.1-flash-1017', 'anthropic/claude-haiku-5.5'],
    consoleUrl: 'https://openrouter.ai/settings/keys',
  },
  {
    value: 'openai_compat',
    get label() { return t('aiProvider.openaiCompat') },
    region: 'local_custom',
    defaultUrl: 'https://api.openai.com',
    defaultModels: ['gpt-4o-mini'],
  },
  {
    value: 'openai',
    // Brand name, identical in every locale (same handling as DeepSeek, Groq, and OpenCode Go).
    // The URL field is editable per profile, so this preset doubles as the proxy/relay entry:
    // point it at any OpenAI-compatible endpoint and the openai request tuning below still applies.
    label: 'OpenAI',
    region: 'global',
    defaultUrl: 'https://api.openai.com',
    defaultModels: ['gpt-4o-mini', 'gpt-5-mini'],
    consoleUrl: 'https://platform.openai.com/api-keys',
  },
  {
    value: 'ollama',
    get label() { return t('aiProvider.ollama') },
    region: 'local_custom',
    defaultUrl: 'http://127.0.0.1:11434',
    defaultModels: ['qwen2.5:7b'],
    keyless: true,
  },
]

/** Regional default when creating a new service; it only affects cases where no provider has been selected yet. */
export function preferredAiProviderValue(): string {
  return 'openai_compat'
}

/**
 * The catalog order with the generic entry that connects directly to overseas endpoints first; the original
 * array order stays unchanged for the migration logic. The help dialog builds its list from this order; the
 * provider dropdown of the service editor uses groupedAiProviders instead.
 */
export function aiProvidersForDisplay(): AiProvider[] {
  const preferred = preferredAiProviderValue()
  if (AI_PROVIDERS[0]?.value === preferred) return AI_PROVIDERS
  return [
    ...AI_PROVIDERS.filter((provider) => provider.value === preferred),
    ...AI_PROVIDERS.filter((provider) => provider.value !== preferred),
  ]
}

// International providers come first and the self-hosted or custom ones last.
const AI_PROVIDER_REGION_ORDER: readonly AiProviderRegion[] = ['global', 'china', 'local_custom']

function aiProviderRegionLabel(region: AiProviderRegion): string {
  switch (region) {
    case 'global': return t('aiProvider.groupGlobal')
    case 'china': return t('aiProvider.groupChina')
    case 'local_custom': return t('aiProvider.groupCustom')
  }
}

/**
 * Providers for the provider dropdown of the service editor: grouped by region, and alphabetical by
 * the displayed label inside each group. AI_PROVIDERS keeps its own order for the migration logic.
 */
export function groupedAiProviders(): { provider: AiProvider; group: string }[] {
  const collator = new Intl.Collator(getLocale(), { numeric: true, sensitivity: 'base' })
  return AI_PROVIDER_REGION_ORDER.flatMap((region) => {
    const group = aiProviderRegionLabel(region)
    return AI_PROVIDERS
      .filter((provider) => provider.region === region)
      .sort((a, b) => collator.compare(a.label, b.label))
      .map((provider) => ({ provider, group }))
  })
}

export function findProvider(value: string): AiProvider {
  return AI_PROVIDERS.find((p) => p.value === value) ?? AI_PROVIDERS[0]
}

/** Fields stored separately for each provider */
export type AiSettingField = 'apiUrl' | 'apiKey' | 'model' | 'models' | 'latency'

/**
 * Config keys for each provider.
 *
 * The key-name format is a historical convention (`cloudAi.<provider>.<field>`), **do not change it arbitrarily**:
 * changing it would make every address and key users already saved unreadable, and the UI would look as if they had been cleared.
 * There is also a separate set without a provider, `cloudAi.provider/apiUrl/apiKey/model`,
 * which is the "current config" actually in effect at runtime; this page syncs it over when saving or switching.
 */
export function aiSettingKey(provider: string, field: AiSettingField): string {
  return `cloudAi.${provider}.${field}`
}

export function providerLabel(value: string): string {
  return AI_PROVIDERS.find((p) => p.value === value)?.label ?? value
}

/**
 * A configured AI service.
 *
 * Why this shape: the old model was organized around the "provider", with models just a string list beneath it,
 * while the address and key were attached to the provider. That had two consequences:
 *   1. Two "OpenAI-compatible" models on different endpoints (e.g. one OpenAI, one local vLLM) could not each be configured
 *      separately: switching models kept the same address and key, so one of them was bound to fail to connect;
 *   2. Switching between DeepSeek and Qwen meant going through the dropdown, changing the address and changing the key, which amounted to reconfiguring everything.
 * Packaging "provider + address + key + model" into one named service makes switching a single click in the list.
 */
/**
 * The result of one availability check.
 *
 * Why not store a separate latencyMs: that would let the UI say only "how fast", never "whether it works".
 * When the user presses this button, the first thing they want to know is whether the config works: is the key valid, is the model enabled,
 * whether the network is reachable. Latency is a second dimension that matters only after availability (it does matter for dictation, but it is not the verdict).
 * Failures must be recorded too: the card has to show "unavailable", not sit at "untested" as if nothing happened.
 */
export interface AiProfileCheck {
  ok: boolean
  /** When the check completed. Used to say "how long ago it was checked": a pass does not mean it still works right now */
  at?: number
  /** Round-trip time of one successful request */
  latencyMs?: number
  /** One-sentence reason for a failure (already normalized by describeProviderError) */
  reason?: string
}

export interface AiProfile {
  id: string
  provider: string
  apiUrl: string
  apiKey: string
  model: string
  /**
   * OpenAI-only request tuning. Only the openai preset renders and sends these:
   * generic OpenAI-compatible endpoints may reject unknown body fields, so they never
   * leave for any other provider. Undefined = the provider decides.
   */
  reasoningEffort?: string
  serviceTier?: string
  /** Most recent availability check. None = not checked yet */
  check?: AiProfileCheck
}

/**
 * Reasoning effort values offered by the openai and opencode_go presets; API literals, not UI copy.
 *
 * The set is model-dependent (verified against developers.openai.com, 2026-10): a model may
 * accept only a subset, and rejects the rest with HTTP 400 listing its valid levels — GPT-6
 * Luna, for example, takes low/medium/high/xhigh/max. OpenCode Zen/Go was probed live
 * (2026-10-07) and accepts this same seven-value set for its chat/completions models. The
 * editor offers the full documented set so no supported level is missing; the hint tells
 * users the provider error is the authority for a given model.
 */
export const REASONING_EFFORT_OPTIONS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * Service tier values offered by the openai preset; API literals, not UI copy.
 * `fast` is the documented Fast-mode alias: the API accepts it and reports the request back
 * as `priority` (verified against developers.openai.com, 2026-10). `flex` is deliberately
 * not offered: it is documented as slower, beta, and limited to selected models — a latency
 * trap in a dictation app.
 */
export const SERVICE_TIER_OPTIONS = ['auto', 'default', 'priority', 'fast'] as const

/**
 * Whether a provider's endpoint accepts the `reasoning_effort` request field.
 * opencode_go is verified live against https://opencode.ai/zen/go (2026-10-07): its
 * chat/completions gateway accepts the field for GLM, DeepSeek, and Kimi models.
 */
export function supportsReasoningEffort(provider: string): boolean {
  return provider === 'openai' || provider === 'opencode_go'
}

/** Whether a provider's endpoint accepts the `service_tier` request field. OpenCode Zen/Go has no tiers. */
export function supportsServiceTier(provider: string): boolean {
  return provider === 'openai'
}

/**
 * Build the `ai_config.extra` wire payload for one profile.
 *
 * Returns undefined when the provider supports neither knob or nothing is set, so profiles
 * that never touched tuning keep sending the exact request body they always did.
 */
function buildAiExtra(
  provider: string,
  reasoningEffort?: string,
  serviceTier?: string,
): Record<string, string> | undefined {
  const extra: Record<string, string> = {}
  const effort = supportsReasoningEffort(provider) ? reasoningEffort?.trim() : ''
  const tier = supportsServiceTier(provider) ? serviceTier?.trim() : ''
  if (effort) extra.reasoning_effort = effort
  if (tier) extra.service_tier = tier
  return Object.keys(extra).length > 0 ? extra : undefined
}

export function buildAiProviderConfig(
  config: Pick<AiProfile, 'provider' | 'apiUrl' | 'apiKey' | 'model' | 'reasoningEffort' | 'serviceTier'>,
) {
  const extra = buildAiExtra(config.provider, config.reasoningEffort, config.serviceTier)
  return {
    provider: config.provider,
    api_url: config.apiUrl,
    api_key: config.apiKey,
    model: config.model,
    ...(extra ? { extra } : {}),
  }
}

export function makeProfileId(): string {
  return `p-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** Initial values when creating a new service */
export function blankProfile(providerValue = preferredAiProviderValue()): AiProfile {
  const meta = findProvider(providerValue)
  return {
    id: makeProfileId(),
    provider: meta.value,
    apiUrl: meta.defaultUrl,
    apiKey: '',
    model: meta.defaultModels[0] ?? '',
  }
}

/**
 * The host name of the endpoint, returned **only when it is not this provider's default address**; otherwise an empty string.
 *
 * Whether a card shows its address depends on whether the address can tell two cards apart. For a card using DeepSeek's official address,
 * writing `api.deepseek.com` just repeats the word "DeepSeek". But for two endpoints both called "OpenAI-compatible",
 * the host name is the only thing that separates them, which is exactly the case the old structure could not store a second copy for.
 * Only the host name is shown, not the full URL: paths (/v1, /compatible-mode) would push the model name out of a narrow card,
 * while the full address is visible in the edit dialog.
 */
function profileCustomHost(profile: AiProfile): string {
  const hostOf = (url: string): string => {
    try {
      return new URL(url).host
    } catch {
      return url.trim()
    }
  }
  const host = hostOf(profile.apiUrl)
  const defaultHost = hostOf(findProvider(profile.provider).defaultUrl)
  return host && host !== defaultHost ? host : ''
}

/** One-line description of a service (provider · host name), for places such as screen-reader labels that can only take a single string */
export function profileSubtitle(profile: AiProfile): string {
  const label = providerLabel(profile.provider)
  const host = profileCustomHost(profile)
  return host ? `${label} · ${host}` : label
}

/** Main title of a row in the list. The model name is the title; when nothing is filled in yet it still needs text, or the row looks broken */
export function profileTitle(profile: AiProfile): string {
  return profile.model.trim() || t('aiProvider.noModel')
}

/**
 * Whether a service has everything it needs to run.
 *
 * Keyless providers may omit the model: the native layer substitutes its own
 * default (Ollama uses qwen2.5:7b), matching the runtime cleanup path in
 * clientAiPolish.
 */
export function isProfileComplete(profile: AiProfile): boolean {
  return assessAiConfig(profile).complete
}

/** Which pieces of a client-side AI configuration are present, and whether the request can run. */
export interface AiConfigCompleteness {
  hasUrl: boolean
  hasKey: boolean
  hasModel: boolean
  complete: boolean
}

/**
 * The single completeness rule for a client-side AI configuration. The AI service card, the client
 * cleanup executor and the server-mode readiness check all use it, so they cannot disagree.
 * A keyless provider needs neither a key nor a model: the native layer substitutes its default model.
 */
export function assessAiConfig(
  config: Pick<AiProfile, 'provider' | 'apiUrl' | 'apiKey' | 'model'>,
): AiConfigCompleteness {
  const keyless = Boolean(findProvider(config.provider).keyless)
  const hasUrl = Boolean(config.apiUrl.trim())
  const hasKey = keyless || Boolean(config.apiKey.trim())
  const hasModel = keyless || Boolean(config.model.trim())
  return { hasUrl, hasKey, hasModel, complete: hasUrl && hasKey && hasModel }
}

/**
 * One model from a provider's remote catalog, as returned by `list_remote_models`.
 * Prices are USD per million tokens; a missing price means the provider did not
 * report a usable value.
 */
export interface RemoteModel {
  id: string
  name?: string
  input_price_per_million?: number
  output_price_per_million?: number
}

/**
 * Id tokens that mark a catalog entry as something other than a text chat model.
 *
 * The AI editor sends plain text to /chat/completions, so batch variants, speech models
 * (TTS, STT, realtime, audio), embeddings, rerankers, moderation/safety classifiers and
 * image/video generators can only fail or burn money there. The catalog endpoint reports
 * no model type to the frontend, so the id is the only signal.
 *
 * Matching is on whole tokens (the id split on every non-alphanumeric run), never on
 * substrings: "tts" must hide "gpt-4o-mini-tts" and "playai-tts-arabic" without ever
 * matching an unrelated id that merely contains those letters.
 */
const NON_CHAT_ID_TOKENS: ReadonlySet<string> = new Set([
  'batch',
  // Speech and voice.
  'tts', 'stt', 'asr', 'whisper', 'transcribe', 'transcription', 'speech', 'voice', 'audio', 'realtime', 'orpheus',
  // Embeddings and ranking.
  'embed', 'embedding', 'embeddings', 'rerank', 'reranker',
  // Moderation and safety classifiers.
  'moderation', 'safety', 'guard', 'safeguard',
  // Image and video generation. "banana" covers Nano Banana ids that omit the word "image";
  // "nano" is deliberately absent because it would hide the chat model gpt-5-nano.
  'image', 'imagen', 'dall', 'sora', 'veo', 'banana',
])

/** Whether a catalog id can plausibly serve the text-cleanup chat request (see NON_CHAT_ID_TOKENS). */
export function isChatModelId(id: string): boolean {
  return !id.toLowerCase().split(/[^a-z0-9]+/).some((token) => NON_CHAT_ID_TOKENS.has(token))
}

/**
 * Normalize the remote model catalog before exposing it in the selector: trim ids, drop
 * empty and duplicate entries, and hide models that are not text chat models.
 *
 * A saved selection that falls out of the list this way is not lost: the editor keeps the
 * saved model as the field's own text (or a chip), not as a catalog row.
 */
export function normalizeRemoteModels(models: RemoteModel[]): RemoteModel[] {
  const seen = new Set<string>()
  const out: RemoteModel[] = []
  for (const model of models) {
    const id = typeof model.id === 'string' ? model.id.trim() : ''
    if (!id || seen.has(id) || !isChatModelId(id)) continue
    seen.add(id)
    out.push({ ...model, id })
  }
  return out
}

/**
 * Restore the value read back from storage into a list of services.
 *
 * Why be so careful: this value passes through config export/import, users hand-editing the database, and field additions and removals in future versions,
 * so no single dirty entry should blank the whole page. The rule is "rescue what can be rescued, drop what cannot", and never throw.
 * Duplicate ids must be handled too: selection and editing both locate entries by id, so a duplicate would make clicking A edit B.
 */
export function parseProfiles(raw: unknown): AiProfile[] {
  if (!Array.isArray(raw)) return []
  const text = (value: unknown): string => (typeof value === 'string' ? value : '')
  const finite = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined
  const used = new Set<string>()
  const out: AiProfile[] = []

  raw.forEach((item, index) => {
    if (!item || typeof item !== 'object') return
    const source = item as Record<string, unknown>

    let id = text(source.id).trim() || `recovered-${index}`
    while (used.has(id)) id = `${id}-${index}`
    used.add(id)

    // Tuning values are validated against the catalog's offered set: a value that is no
    // longer offered (a removed tier) or was hand-edited would stay invisible in the editor
    // and keep failing the request, so it is dropped here instead of lingering.
    const reasoningEffort = text(source.reasoningEffort).trim()
    const serviceTier = text(source.serviceTier).trim()
    const keepReasoningEffort = (REASONING_EFFORT_OPTIONS as readonly string[]).includes(reasoningEffort)
    const keepServiceTier = (SERVICE_TIER_OPTIONS as readonly string[]).includes(serviceTier)

    out.push({
      id,
      provider: text(source.provider) || AI_PROVIDERS[0].value,
      apiUrl: text(source.apiUrl),
      apiKey: text(source.apiKey),
      model: text(source.model),
      ...(keepReasoningEffort ? { reasoningEffort } : {}),
      ...(keepServiceTier ? { serviceTier } : {}),
      check: parseCheck(source.check, source.latencyMs, finite),
    })
  })

  return out
}

/** Fault-tolerant parsing of a check result. The second argument is latencyMs, which earlier versions stored flat on the profile; it was only written when a check passed. */
function parseCheck(
  raw: unknown,
  legacyLatency: unknown,
  finite: (value: unknown) => number | undefined,
): AiProfileCheck | undefined {
  if (raw && typeof raw === 'object') {
    const source = raw as Record<string, unknown>
    if (typeof source.ok === 'boolean') {
      const reason = typeof source.reason === 'string' ? source.reason.trim() : ''
      return {
        ok: source.ok,
        at: finite(source.at),
        latencyMs: finite(source.latencyMs),
        reason: reason || undefined,
      }
    }
  }
  const latency = finite(legacyLatency)
  return latency === undefined ? undefined : { ok: true, latencyMs: latency }
}

/** The currently enabled entry. If the id is no longer valid (deleted, or the imported data does not match), fall back to the first entry instead of "nothing enabled" */
export function resolveActiveProfile(profiles: AiProfile[], activeId: string): AiProfile | null {
  if (profiles.length === 0) return null
  return profiles.find((p) => p.id === activeId) ?? profiles[0]
}

/**
 * Draft for the "New" action.
 *
 * It deliberately never looks like a copy of an existing card: URL and key always come from the
 * selected provider's own defaults, never from a saved profile. The model starts empty: a seeded
 * name would be saved next to whatever the user picks and goes stale as providers retire models,
 * so `defaultModels` only supplies the placeholder example. Several models can be entered in one
 * new draft; each becomes its own card sharing the URL and key.
 */
export function newDraftProfile(profiles: AiProfile[], activeId: string): AiProfile {
  const active = resolveActiveProfile(profiles, activeId)
  return { ...blankProfile(active?.provider), model: '' }
}

/**
 * Resolve the URL a save, a connection test, or a model-list request should use.
 *
 * A provider marked urlOptional treats a blank field as its official endpoint, so
 * clearing the field must neither block the request nor change where it goes.
 * The editor's save path and its live checks all call this, so they cannot drift;
 * the stored profile always carries the resolved value, which keeps
 * isProfileComplete() and the custom-host display working unchanged.
 */
export function effectiveApiUrl(providerValue: string, apiUrl: string): string {
  const trimmed = apiUrl.trim()
  if (trimmed) return trimmed
  const provider = findProvider(providerValue)
  return provider.urlOptional ? provider.defaultUrl : ''
}

/**
 * Resolve blank URLs of optional-URL providers in a loaded list.
 *
 * Profiles can reach storage without ever passing the editor (full-backup import,
 * a hand-edited database), where nothing resolved the blank. The optional-URL
 * promise belongs to reading a list, not to one screen, so ingestion normalizes
 * those entries to the official endpoint. Providers that require a URL keep
 * whatever was stored: the incomplete card and the save-time error stay the
 * honest signal there.
 *
 * Returns the same array instance when nothing needed resolving, so a caller can
 * use a reference comparison to decide whether to write the list back.
 */
export function normalizeProfiles(profiles: AiProfile[]): AiProfile[] {
  let changed = false
  const out = profiles.map((profile) => {
    if (profile.apiUrl.trim()) return profile
    const meta = findProvider(profile.provider)
    if (!meta.urlOptional) return profile
    changed = true
    return { ...profile, apiUrl: meta.defaultUrl }
  })
  return changed ? out : profiles
}

/** The most recently saved profile of a provider that has a URL — the source for reused credentials. */
export function lastProfileOf(profiles: AiProfile[], providerValue: string): AiProfile | undefined {
  return [...profiles].reverse().find((p) => p.provider === providerValue && p.apiUrl.trim() !== '')
}

/** Fields that follow the new provider when the editor's provider select changes. */
export interface ProviderSwitchResult {
  provider: string
  apiUrl: string
  apiKey: string
  models: string[]
}

/**
 * Apply a provider change inside the editor.
 *
 * Only values still matching what was seeded for the current provider are replaced; anything the
 * user typed must survive a mis-click of the dropdown. The seeds are the card's own saved profile
 * (when editing) and the provider's most recent saved profile, so values auto-filled by an earlier
 * switch also count: A -> B -> A must not leave B's key on A while the reuse hint disappears.
 *
 * Model names left over from the provider's own preset (its examples and its recommendations) are
 * dropped, not swapped for the target's preset: a model id of one provider is meaningless on another,
 * and no preset is seeded any more.
 */
export function applyProviderSwitch(
  draft: AiProfile,
  models: string[],
  nextProvider: string,
  profiles: AiProfile[],
): ProviderSwitchResult {
  const from = findProvider(draft.provider)
  const to = findProvider(nextProvider)
  const previous = lastProfileOf(profiles, nextProvider)
  const seeds = [profiles.find((p) => p.id === draft.id), lastProfileOf(profiles, draft.provider)]
    .filter((p): p is AiProfile => p !== undefined)
  const urlSeeded = seeds.some((s) => draft.apiUrl.trim() === s.apiUrl.trim())
  const keySeeded = seeds.some((s) => draft.apiKey === s.apiKey)
  const urlBoilerplate = draft.apiUrl.trim() === '' || draft.apiUrl.trim() === from.defaultUrl || urlSeeded
  const modelsBoilerplate = models.length === 0
    || models.every((m) => from.defaultModels.includes(m) || from.recommendedModels?.includes(m))
  return {
    provider: nextProvider,
    apiUrl: urlBoilerplate ? previous?.apiUrl || to.defaultUrl : draft.apiUrl,
    apiKey: draft.apiKey.trim() === '' || keySeeded ? previous?.apiKey ?? '' : draft.apiKey,
    models: modelsBoilerplate ? [] : models,
  }
}

/**
 * Checks the API key format and returns a hint text (an empty string means the format is fine).
 *
 * Only rules that almost never produce false alarms are kept: stray whitespace that often comes along when pasting, and fixed prefix conventions.
 * The code also used to assert that DeepSeek / Tongyi Qianwen keys "must be 35 characters" and that Doubao keys "must be a UUID". Once a provider changes its key
 * length, this starts warning about **valid** keys, and the user's first reaction to a warning is to go regenerate a key.
 * A false alarm on a valid key costs more than a missed one, so the length assertions were removed.
 */
export function checkAiKeyFormat(provider: string, key: string): string {
  if (!key.trim()) return ''
  if (/\s/.test(key)) {
    return t('aiProvider.keyHasSpace')
  }
  if ((provider === 'deepseek' || provider === 'qwen') && !/^sk-/.test(key.trim())) {
    return t('aiProvider.keyPrefix', { provider: providerLabel(provider) })
  }
  return ''
}

/** Whether an address looks like a usable base URL. There was no validation at all before, so a wrong address was only discovered once a test failed. */
export function checkApiUrl(url: string): string {
  const u = url.trim()
  if (!u) return ''
  if (!/^https?:\/\//i.test(u)) {
    return t('aiProvider.urlNeedsScheme')
  }
  try {
    const parsed = new URL(u)
    if (!parsed.hostname) return t('aiProvider.urlInvalid')
  } catch {
    return t('aiProvider.urlInvalid')
  }
  return ''
}

/**
 * Extract the "Reply: xxx" sentence from the backend detail.
 *
 * The full detail is four lines, `latency/model/sent/reply` (see test_connection in ai_openai_compat.rs), where the "sent" line
 * shows the internal test prompt
 * (`system="只回复「连接正常」四个字…"`, i.e. "reply with only the words 'Connection OK'") verbatim to the user, which is backend debug information.
 * It must not appear in the success message. Only the "reply" is taken here; latency and model name come from structured fields.
 */
export function extractTestReply(detail?: string): string {
  const match = detail?.match(/^回复:\s*(.*)$/m) // i18n-allow: matches the Chinese response field returned by the provider
  return match?.[1]?.trim() ?? ''
}

export function formatLatency(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

/**
 * Latency tiers.
 *
 * Dictation is judged differently from benchmarks: the user releases the hotkey, stands still and waits for the text to appear at the cursor,
 * a round trip over 1 second is already noticeable as a pause, and anything over 2 seconds is basically unusable for getting work done.
 * So raw numbers alone are not enough: 1.4s and 140ms must look different on screen.
 *
 * Tiers attach a word only when a warning is needed: when it is fast enough, an extra "very fast" is just noise, and only a slowdown is worth the space.
 * Colors have only two levels, ok / warn: red is already taken on this page by "unavailable",
 * so "usable but slow" must not share a color with "not usable at all".
 */
export type LatencyTier = 'instant' | 'fast' | 'normal' | 'slow' | 'tooSlow'

export interface LatencyGrade {
  tier: LatencyTier
  /** One-word verdict, shown together with the number */
  label: string
  /** ok = safe to use, warn = usable but sluggish, bad = not recommended */
  tone: 'ok' | 'warn' | 'bad'
}

/** Threshold values are kept here; to tune the feel, change only this place */
const LATENCY_THRESHOLDS = { instant: 200, fast: 500, normal: 1000, slow: 2000 } as const

export function gradeLatency(ms: number): LatencyGrade {
  if (ms < LATENCY_THRESHOLDS.instant) return { tier: 'instant', label: t('grade.instant'), tone: 'ok' }
  if (ms < LATENCY_THRESHOLDS.fast) return { tier: 'fast', label: t('grade.fast'), tone: 'ok' }
  if (ms < LATENCY_THRESHOLDS.normal) return { tier: 'normal', label: t('grade.normal'), tone: 'ok' }
  if (ms < LATENCY_THRESHOLDS.slow) return { tier: 'slow', label: t('grade.slow'), tone: 'warn' }
  return { tier: 'tooSlow', label: t('grade.tooSlow'), tone: 'bad' }
}

/**
 * Freshness window for a check result.
 *
 * Why this is needed: a passing check is only a fact about that moment. Used-up quota, a revoked key, a retired model,
 * or provider rate limiting can all silently invalidate it, while the green "available" badge keeps showing,
 * turning into an open-ended promise: a green light from three days ago reads exactly like one from a minute ago.
 * Once the freshness window passes, the color goes back to neutral: green only means "verified just now, can be trusted".
 */
export const CHECK_FRESH_MS = 24 * 60 * 60 * 1000

/** Whether the result is still fresh. A result without a timestamp (migrated from an earlier version) always counts as stale, and one re-check fixes it */
export function isCheckFresh(check: AiProfileCheck | undefined, now = Date.now()): boolean {
  if (!check?.at) return false
  return now - check.at < CHECK_FRESH_MS
}

/**
 * "How long ago it was checked".
 *
 * Why show this: a passing check does not mean it still passes right now (used-up quota, a revoked key, or a retired model all change that).
 * If the "available" tag on the card does not say when it was checked, it turns into an open-ended promise.
 * now is passed in as a parameter, so the pure function is easy to test.
 */
export function formatCheckedAt(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return t('time.justNow')
  // Use Intl.RelativeTimeFormat instead of concatenating strings by hand: English singular/plural forms ("1 minute ago"
  // vs "5 minutes ago") cannot be covered by one template, and this is the detail most easily overlooked and most amateurish to get wrong.
  const rtf = new Intl.RelativeTimeFormat(getLocale(), { numeric: 'auto' })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return rtf.format(-minutes, 'minute')
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return rtf.format(-hours, 'hour')
  return rtf.format(-Math.floor(hours / 24), 'day')
}

// ── Legacy data migration ────────────────────────────────────────────────────────────

/** Legacy shape: one config set per provider, with the model stored as a comma-separated string */
export interface LegacyProviderData {
  provider: string
  apiUrl: string
  apiKey: string
  /** The model that was selected at the time */
  model: string
  /** Candidate model list */
  models: string[]
  /** Latency table parsed from `model=ms,model=ms` */
  latencies: Record<string, number>
}

/**
 * Parse `model=ms,model=ms` into a table (older versions stored the entire latency table as a single string).
 *
 * Read-only, never written: the new structure keeps latency on each service's latencyMs field. Corrupt entries are always skipped:
 * this is only display data used to sort by "which is faster", and one dirty entry must never make the whole migration fail.
 */
export function parseLegacyLatencies(raw: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const part of raw.split(',')) {
    const [name, ms] = part.split('=')
    const value = Number(ms)
    if (name?.trim() && ms !== undefined && ms !== '' && Number.isFinite(value)) {
      out[name.trim()] = value
    }
  }
  return out
}

/**
 * Flatten the legacy "one config set per provider" into a list of services.
 *
 * Rules: only entries that are complete are migrated (they have an address, and either a key or no key requirement); each candidate model under that provider becomes its own entry;
 * the legacy "current provider + current model" becomes the enabled entry. Legacy storage keys are never deleted, so rolling back to an older version still works,
 * and a migration error does not cost the user their keys.
 */
export function migrateLegacyProfiles(
  legacy: LegacyProviderData[],
  activeProvider: string,
  activeModel: string,
): { profiles: AiProfile[]; activeId: string } {
  const profiles: AiProfile[] = []

  for (const entry of legacy) {
    const meta = findProvider(entry.provider)
    const url = entry.apiUrl.trim() || meta.defaultUrl
    if (!url) continue
    if (!meta.keyless && !entry.apiKey.trim()) continue

    // Candidate list plus the model selected at the time, de-duplicated, each becoming its own entry
    const models = [...entry.models]
    if (entry.model && !models.includes(entry.model)) models.unshift(entry.model)
    const unique = models.map((m) => m.trim()).filter(Boolean).filter((m, i, a) => a.indexOf(m) === i)
    if (unique.length === 0) continue

    for (const model of unique) {
      const latencyMs = entry.latencies[model]
      profiles.push({
        // Migration uses a deterministic id: easy to trace, and it guarantees that repeated migrations never create two copies
        id: `legacy-${entry.provider}-${model}`,
        provider: entry.provider,
        apiUrl: url,
        apiKey: entry.apiKey,
        model,
        // Older versions only recorded latency after a successful check, so having latency means a check had passed once;
        // but nobody knows when that check happened, so `at` is not written (the UI will not claim it was "just checked")
        check: latencyMs === undefined ? undefined : { ok: true, latencyMs },
      })
    }
  }

  const matched = profiles.find((p) => p.provider === activeProvider && p.model === activeModel)
    ?? profiles.find((p) => p.provider === activeProvider)
    ?? profiles[0]

  return { profiles, activeId: matched?.id ?? '' }
}
