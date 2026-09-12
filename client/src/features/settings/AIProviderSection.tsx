// "AI Services" — One card = One complete, usable configuration (provider + URL + key + model).
//
// Why this differs from the legacy "select provider first, then fill in details":
// Under the previous model, storage was slotted strictly per provider (`cloudAi.<provider>.*`). Consequently:
//   1. Two "OpenAI Compatible" configs pointing to different endpoints could not coexist physically.
//      Switching models only modified the model field while URL and key remained unchanged, forcing both
//      models to hit the same endpoint (one was inevitably broken).
//   2. Candidate models were filtered by the active provider. Comparing response speeds between DeepSeek
//      and Qwen required tedious dropdown toggling, even though round-trip latency is the single most
//      critical metric in dictation scenarios.
// Now, each card represents a self-contained configuration where clicking immediately activates the full set.
// The grid is flat, allowing all candidates to be compared side by side.
//
// The visual structure follows existing workspace patterns:
//   - Radio card grid matches `WorkModeSection` and the theme selector:
//     `role="radiogroup"` + `grid gap-3 sm:grid-cols-3`, active state `border-primary bg-primary/5`
//     with a checkmark so selection does not depend solely on color.
//   - Create / Edit / Delete uses `Modal` (sharing the shell with model directory and deletion dialogs):
//     Includes Escape handling, focus trapping, and focus restoration on close.
//
// Card display criteria focuses on distinguishing cards:
// Model name and provider are always visible; custom hostname is shown only when non-default;
// full URL is available in the edit modal. Latency is the primary benchmark metric and remains visible.

import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open as shellOpen } from '@tauri-apps/plugin-shell'
import { CheckCircle2, ExternalLink, Info, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Feedback, FormatHint, type FeedbackTone } from '@/components/ui/feedback'
import { Modal } from '@/components/ui/modal'
import { PasswordInput } from '@/components/ui/password-input'
import { Switch } from '@/components/ui/switch'
import { Select } from '@/components/ui/select'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { getSetting, setSetting } from '@/services/store'
import {
  SERVER_AI_SOURCE_KEY,
  setRuntimeServerAiSource,
  type ServerAiSource,
} from '@/services/transcription/serverAiSource'
import { setEngineDraftDirty } from '@/stores/engineDraft'
import { describeProviderError } from '@/lib/errorMessages'
import {
  aiProvidersForDisplay,
  blankProfile,
  checkAiKeyFormat,
  checkApiUrl,
  extractTestReply,
  findProvider,
  formatCheckedAt,
  formatLatency,
  gradeLatency,
  isCheckFresh,
  isProfileComplete,
  normalizeModelNames,
  profileSubtitle,
  profileTitle,
  preferredAiProviderValue,
  providerLabel,
  resolveActiveProfile,
  type AiProfile,
  type AiProfileCheck,
} from './aiProviderCatalog'
import { loadAiProfiles, saveAiProfiles } from './aiProfileStore'
import { getLocale, t } from '@/i18n'
import { useT } from '@/i18n/useT'

interface TestResult { ok: boolean; message: string; elapsed_ms: number; detail?: string }

interface FetchModelsResult { ok: boolean; models: string[]; message: string }

interface Notice {
  tone: FeedbackTone
  message: string
  detail?: string
  /** Where to display the result: inside the modal ('editor') or beneath the grid ('list') */
  scope: 'editor' | 'list'
}

interface TestOutcome {
  ok: boolean
  elapsedMs: number
  reply: string
  message: string
  detail?: string
}

/** Baseline snapshot for determining dirty state: model list is included, check outcome is excluded */
function draftSnapshot(draft: AiProfile, models: string[]): string {
  return JSON.stringify({
    provider: draft.provider,
    apiUrl: draft.apiUrl,
    apiKey: draft.apiKey,
    models,
  })
}

/** Summarize a test result into a persisted check outcome */
function outcomeToCheck(outcome: TestOutcome): AiProfileCheck {
  return outcome.ok
    ? { ok: true, at: Date.now(), latencyMs: outcome.elapsedMs }
    : { ok: false, at: Date.now(), reason: outcome.message }
}

interface CardStatus {
  /** Visible label on the card tag: shows only elapsed ms when available, using color for speed tiers */
  text: string
  /** Background and text tone of the status pill */
  box: string
  /** Full spoken text for screen readers including qualitative assessment */
  spoken: string
  /** Tooltip explanation string */
  hint: string
}

/**
 * Categorize latency into visual feedback tones.
 * Above 1s introduces noticeable pause during dictation; above 2s is generally unusable for live workflow.
 */
function latencyTone(ms: number): FeedbackTone {
  return gradeLatency(ms).tone === 'ok' ? 'success' : 'warning'
}

/** One-line verdict message */
function successMessage(model: string, ms: number): string {
  const grade = gradeLatency(ms)
  if (grade.tier === 'tooSlow') {
    return t('ai.msg.tooSlow', { model, latency: formatLatency(ms) })
  }
  if (grade.tier === 'slow') {
    return t('ai.msg.slow', { model, latency: formatLatency(ms) })
  }
  return t('ai.msg.ok', { model, latency: formatLatency(ms), grade: grade.label })
}

/** Full diagnostic readout following a successful test */
function successDetail(profile: AiProfile, outcome: TestOutcome): string {
  const grade = gradeLatency(outcome.elapsedMs)
  return [
    t('ai.detail.provider', { value: providerLabel(profile.provider) }),
    t('ai.detail.model', { value: profile.model }),
    t('ai.detail.endpoint', { value: profile.apiUrl }),
    t('ai.detail.roundTrip', { latency: formatLatency(outcome.elapsedMs), grade: grade.label }),
    outcome.reply ? t('ai.detail.reply', { value: outcome.reply }) : '',
    t('ai.detail.time', { value: new Date().toLocaleTimeString(getLocale(), { hour12: false }) }),
  ].filter(Boolean).join('\n')
}

function renderStatusChip(status: CardStatus) {
  const chip = (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium tabular-nums',
        status.box,
        status.hint && 'cursor-help',
      )}
    >
      {status.text}
    </span>
  )
  if (!status.hint) return <span className="shrink-0">{chip}</span>
  return (
    <Tooltip variant="light" className="pointer-events-auto relative z-10 shrink-0" content={status.hint}>
      {chip}
    </Tooltip>
  )
}

const NEUTRAL_BOX = 'bg-muted text-muted-foreground'

/**
 * Determine status tag display properties for an AI profile card.
 * Only displays latency numbers when available, relying on color and tooltips for qualitative tiers.
 */
function describeStatus(profile: AiProfile, checking: boolean): CardStatus {
  if (checking) {
    return { text: t('ai.status.testing'), box: 'bg-warning/10 text-warning-strong', spoken: t('ai.status.testing'), hint: t('ai.status.testingHint') }
  }

  const check = profile.check
  if (!check) {
    return isProfileComplete(profile)
      ? { text: t('ai.status.untested'), box: NEUTRAL_BOX, spoken: t('ai.status.untested'), hint: t('ai.status.untestedHint') }
      : { text: t('ai.status.incomplete'), box: NEUTRAL_BOX, spoken: t('ai.status.incomplete'), hint: t('ai.status.incompleteHint') }
  }

  const fresh = isCheckFresh(check)
  const when = (verdict: string): string =>
    check.at
      ? t('ai.status.whenKnown', { when: formatCheckedAt(check.at), verdict })
      : t('ai.status.whenUnknown', { verdict })
  const staleNote = fresh ? '' : t('ai.status.staleNote')

  if (!check.ok) {
    return {
      text: t('ai.status.unavailable'),
      box: fresh ? 'bg-destructive/10 text-destructive-strong' : NEUTRAL_BOX,
      spoken: t('ai.status.unavailable'),
      hint: [when(t('ai.status.verdictFail')), check.reason, staleNote].filter(Boolean).join(' · '),
    }
  }

  const ms = check.latencyMs
  if (ms === undefined) {
    return {
      text: t('ai.status.available'),
      box: fresh ? 'bg-success/10 text-success-strong' : NEUTRAL_BOX,
      spoken: t('ai.status.available'),
      hint: [when(t('ai.status.verdictPass')), staleNote].filter(Boolean).join(' · '),
    }
  }

  const grade = gradeLatency(ms)
  const box = !fresh
    ? NEUTRAL_BOX
    : grade.tone === 'bad'
      ? 'bg-destructive/15 text-destructive-strong'
      : grade.tone === 'warn'
        ? 'bg-warning/10 text-warning-strong'
        : 'bg-success/10 text-success-strong'

  return {
    text: formatLatency(ms),
    box,
    spoken: t('ai.status.availableSpoken', { grade: grade.label, latency: formatLatency(ms) }),
    hint: [
      when(t('ai.status.verdictPass')),
      grade.label,
      grade.tier === 'tooSlow' ? t('ai.status.tooSlowNote') : '',
      staleNote,
    ].filter(Boolean).join(' · '),
  }
}

const pickAdvice = () => t('ai.pickAdvice')

const inputClass = 'h-9 w-full rounded-md border border-input-border bg-input-bg px-3 text-sm transition-colors focus:border-input-focus-border'
const linkClass = 'inline-flex items-center gap-1 text-xs text-primary underline underline-offset-2 decoration-primary/40 transition-colors hover:decoration-primary'
const cardIconButtonClass = 'pointer-events-auto rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40'
const helpIconClass = 'h-3.5 w-3.5 shrink-0 cursor-help text-muted-foreground/50 transition-colors hover:text-muted-foreground'

export default function AIProviderSection() {
  useT()
  const [profiles, setProfiles] = useState<AiProfile[]>([])
  const [activeId, setActiveId] = useState('')
  const [loaded, setLoaded] = useState(false)
  /** Active profile draft being edited in the modal. null = closed */
  const [draft, setDraft] = useState<AiProfile | null>(null)
  const [draftIsNew, setDraftIsNew] = useState(false)
  /** List of model names to save under the shared provider endpoint and credentials */
  const [draftModels, setDraftModels] = useState<string[]>([])
  const [modelInput, setModelInput] = useState('')
  /** Remote models are a temporary selector catalog, not persisted profiles. */
  const [availableModels, setAvailableModels] = useState<string[]>([])
  /** Whether the model catalog is being fetched from the endpoint. */
  const [fetchingModels, setFetchingModels] = useState(false)
  /** Snapshot taken when opening the modal, used to determine unsaved changes */
  const [draftBaseline, setDraftBaseline] = useState('')
  const [saving, setSaving] = useState(false)
  const [testingDraft, setTestingDraft] = useState(false)
  const [checkingId, setCheckingId] = useState('')
  const [pendingDeleteId, setPendingDeleteId] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [serverAiSource, setServerAiSource] = useState<ServerAiSource>('managed')
  const [savingServerAiSource, setSavingServerAiSource] = useState(false)
  const [serverAiSourceError, setServerAiSourceError] = useState(false)
  const [serverAiSourceLoaded, setServerAiSourceLoaded] = useState(false)
  const [isServerMode, setIsServerMode] = useState(false)
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null)
  const [checkingIds, setCheckingIds] = useState<string[]>([])

  const draftProvider = findProvider(draft?.provider ?? '')
  const draftNeedsKey = !draftProvider.keyless
  const draftUrlError = draft ? checkApiUrl(draft.apiUrl) : ''
  const draftKeyHint = draft && draftNeedsKey ? checkAiKeyFormat(draft.provider, draft.apiKey) : ''
  const selectedModel = draft?.model.trim() ?? ''
  const modelOptions = selectedModel && !availableModels.includes(selectedModel)
    ? [selectedModel, ...availableModels]
    : availableModels
  const draftSignature = draft ? draftSnapshot(draft, draftModels) : ''
  const draftDirty = draft !== null && (draftSignature !== draftBaseline || modelInput.trim() !== '')
  const draftKeyInherited = draft !== null
    && draftIsNew
    && draft.apiKey.trim() !== ''
    && lastProfileOf(draft.provider)?.apiKey === draft.apiKey
  const busy = saving || fetchingModels || testingDraft || checkingId !== '' || batch !== null
  const isChecking = (id: string) => checkingId === id || checkingIds.includes(id)
  const pendingDelete = profiles.find((p) => p.id === pendingDeleteId) ?? null

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const state = await loadAiProfiles()
      setProfiles(state.profiles)
      setActiveId(state.activeId)
      setLoaded(true)
    })()

    void Promise.all([
      getSetting('workMode', 'server').catch(() => 'server'),
      getSetting(SERVER_AI_SOURCE_KEY, 'managed').catch(() => 'managed'),
    ]).then(([mode, value]) => {
      if (cancelled) return
      const source = value === 'custom' ? 'custom' : 'managed'
      setServerAiSource(source)
      setRuntimeServerAiSource(source)
      setIsServerMode(mode === 'server')
      setServerAiSourceLoaded(true)
    })

    return () => {
      cancelled = true
      setEngineDraftDirty(false)
    }
  }, [])

  useEffect(() => { setEngineDraftDirty(draftDirty) }, [draftDirty])

  async function handleServerAiSource(next: ServerAiSource) {
    if (savingServerAiSource || next === serverAiSource) return
    const previous = serverAiSource
    setServerAiSource(next)
    setRuntimeServerAiSource(next)
    setSavingServerAiSource(true)
    setServerAiSourceError(false)
    try {
      await setSetting(SERVER_AI_SOURCE_KEY, next)
    } catch {
      setServerAiSource(previous)
      setRuntimeServerAiSource(previous)
      setServerAiSourceError(true)
    } finally {
      setSavingServerAiSource(false)
    }
  }

  async function persist(nextProfiles: AiProfile[], nextActiveId: string) {
    const active = resolveActiveProfile(nextProfiles, nextActiveId)
    setProfiles(nextProfiles)
    setActiveId(active?.id ?? '')
    await saveAiProfiles({ profiles: nextProfiles, activeId: nextActiveId })
  }

  function openEditor(profile: AiProfile, isNew: boolean) {
    const models = profile.model.trim() ? [profile.model.trim()] : []
    setDraft(profile)
    setDraftIsNew(isNew)
    setDraftModels(models)
    setModelInput('')
    setAvailableModels([])
    setDraftBaseline(draftSnapshot(profile, models))
    setNotice(null)
  }

  function closeEditor() {
    if (saving || fetchingModels || testingDraft) return
    setDraft(null)
    setDraftIsNew(false)
    setDraftModels([])
    setModelInput('')
    setAvailableModels([])
    setDraftBaseline('')
    setNotice(null)
    setEngineDraftDirty(false)
  }

  function addModel(name: string) {
    const value = name.trim()
    setModelInput('')
    setNotice(null)
    if (!value || draftModels.includes(value)) return
    setDraftModels([...draftModels, value])
  }

  function removeModel(name: string) {
    setDraftModels(draftModels.filter((m) => m !== name))
    clearDraftCheck()
    setNotice(null)
  }

  function selectModel(name: string) {
    setDraftModels(name ? [name] : [])
    setModelInput('')
    patchDraft({ model: name })
  }

  /**
   * Load a temporary model catalog for the configured chat endpoint.
   * The catalog is kept separate from draftModels: each fetched name is an option, not a new profile.
   */
  async function handleFetchModels() {
    if (!draft || busy) return
    const urlError = checkApiUrl(draft.apiUrl)
    if (urlError) {
      setNotice({ tone: 'warning', scope: 'editor', message: urlError })
      return
    }
    if (!draft.apiUrl.trim()) {
      setNotice({
        tone: 'warning',
        scope: 'editor',
        message: draftNeedsKey ? t('ai.err.apiUrlEmpty') : t('ai.err.ollamaUrlEmpty'),
      })
      return
    }

    setFetchingModels(true)
    setAvailableModels([])
    setNotice(null)
    try {
      const result = await invoke<FetchModelsResult>('list_remote_models', {
        config: {
          provider: draft.provider,
          api_url: draft.apiUrl,
          api_key: draft.apiKey,
          model: '',
        },
      })
      if (!result.ok) {
        const friendly = describeProviderError(result.message)
        setNotice({ tone: 'error', scope: 'editor', message: friendly.message, detail: friendly.detail })
        return
      }
      const models = normalizeModelNames(result.models)
      if (models.length === 0) {
        setNotice({ tone: 'warning', scope: 'editor', message: t('ai.msg.noModels') })
        return
      }
      setAvailableModels(models)
      setDraftModels(selectedModel ? [selectedModel] : [])
      setModelInput('')
      setNotice({ tone: 'success', scope: 'editor', message: t('ai.msg.modelsLoaded', { count: models.length }) })
    } catch (err) {
      const friendly = describeProviderError(err)
      setNotice({ tone: 'error', scope: 'editor', message: friendly.message, detail: friendly.detail })
    } finally {
      setFetchingModels(false)
    }
  }

  function handleActivate(id: string) {
    if (id === activeId) return
    setNotice(null)
    void persist(profiles, id)
  }

  async function handleDelete(id: string) {
    const next = profiles.filter((p) => p.id !== id)
    setPendingDeleteId('')
    if (draft?.id === id) closeEditor()
    setNotice(null)
    await persist(next, id === activeId ? '' : activeId)
  }

  function handleDraftProvider(value: string) {
    if (!draft) return
    const from = findProvider(draft.provider)
    const to = findProvider(value)
    const previous = lastProfileOf(value)
    const boilerplate = draft.apiUrl.trim() === '' || draft.apiUrl.trim() === from.defaultUrl
    const url = boilerplate ? previous?.apiUrl || to.defaultUrl : draft.apiUrl
    const apiKey = draft.apiKey.trim() === '' ? previous?.apiKey ?? '' : draft.apiKey
    const stillBoilerplate = draftModels.length === 0
      || draftModels.every((m) => from.defaultModels.includes(m))
    if (stillBoilerplate) {
      setDraftModels(to.defaultModels[0] ? [to.defaultModels[0]] : [])
    }
    setAvailableModels([])
    setDraft({ ...draft, provider: value, apiUrl: url, apiKey, check: undefined })
    setNotice(null)
  }

  function patchDraft(patch: Partial<AiProfile>) {
    if (!draft) return
    if ('provider' in patch || 'apiUrl' in patch) setAvailableModels([])
    setDraft({ ...draft, ...patch, check: undefined })
    setNotice(null)
  }

  /** A change to the model set makes the last test result describe a different configuration. */
  function clearDraftCheck() {
    setDraft((prev) => (prev ? { ...prev, check: undefined } : null))
  }

  function lastProfileOf(providerValue: string): AiProfile | undefined {
    return [...profiles].reverse().find((p) => p.provider === providerValue && p.apiUrl.trim() !== '')
  }

  function makeDraft(providerValue?: string): AiProfile {
    const active = resolveActiveProfile(profiles, activeId)
    const target = providerValue ?? active?.provider ?? preferredAiProviderValue()
    const fresh = blankProfile(target)
    const previous = lastProfileOf(target)
    return previous
      ? { ...fresh, apiUrl: previous.apiUrl, apiKey: previous.apiKey }
      : fresh
  }

  async function runTest(profile: AiProfile): Promise<TestOutcome> {
    try {
      const result = await invoke<TestResult>('test_ai_connection', {
        config: {
          provider: profile.provider,
          api_url: profile.apiUrl,
          api_key: profile.apiKey,
          model: profile.model,
        },
      })
      if (result.ok) {
        return { ok: true, elapsedMs: result.elapsed_ms, reply: extractTestReply(result.detail), message: '' }
      }
      const friendly = describeProviderError(result.message)
      return { ok: false, elapsedMs: 0, reply: '', message: friendly.message, detail: friendly.detail }
    } catch (err) {
      const friendly = describeProviderError(err)
      return { ok: false, elapsedMs: 0, reply: '', message: friendly.message, detail: friendly.detail }
    }
  }

  /**
   * Test the active editor draft endpoint and credentials against the real service.
   *
   * This gives instant feedback without saving the profile or closing the editor modal,
   * keeping network tests separate from persistence.
   */
  async function handleTestDraft() {
    if (!draft || busy) return

    const base = {
      provider: draft.provider,
      apiUrl: draft.apiUrl.trim(),
      apiKey: draft.apiKey.trim(),
    }
    const urlError = checkApiUrl(base.apiUrl)
    if (urlError) {
      setNotice({ tone: 'warning', scope: 'editor', message: urlError })
      return
    }
    if (!base.apiUrl) {
      setNotice({
        tone: 'warning',
        scope: 'editor',
        message: draftNeedsKey ? t('ai.err.apiUrlEmpty') : t('ai.err.ollamaUrlEmpty'),
      })
      return
    }
    if (draftNeedsKey && !base.apiKey) {
      setNotice({ tone: 'warning', scope: 'editor', message: t('ai.err.testNoKey') })
      return
    }

    const testModel = draftModels[0] || modelInput.trim() || draft.model.trim()
    if (!testModel) {
      setNotice({ tone: 'warning', scope: 'editor', message: t('ai.err.testNoModel') })
      return
    }

    setTestingDraft(true)
    setNotice(null)

    const testProfile: AiProfile = {
      ...draft,
      ...base,
      model: testModel,
    }

    const outcome = await runTest(testProfile)
    setTestingDraft(false)

    if (outcome.ok) {
      setDraft((prev) => (prev ? { ...prev, check: outcomeToCheck(outcome) } : null))
      setNotice({
        tone: latencyTone(outcome.elapsedMs),
        scope: 'editor',
        message: successMessage(testModel, outcome.elapsedMs),
        detail: successDetail(testProfile, outcome),
      })
    } else {
      setNotice({
        tone: 'error',
        scope: 'editor',
        message: t('ai.msg.modelFailed', { model: testModel, message: outcome.message }),
        detail: outcome.detail,
      })
    }
  }

  /**
   * Persist the draft provider configuration to disk.
   *
   * Network connection testing is decoupled into a dedicated test button in the editor,
   * avoiding unwanted billable API calls when users simply want to save or configure endpoints.
   */
  async function handleSave() {
    if (!draft || busy) return

    // Auto-collect input text when saving if the user typed a model name without pressing Enter.
    const models = modelInput.trim() && !draftModels.includes(modelInput.trim())
      ? [...draftModels, modelInput.trim()]
      : draftModels

    const base = {
      provider: draft.provider,
      apiUrl: draft.apiUrl.trim(),
      apiKey: draft.apiKey.trim(),
    }
    const urlError = checkApiUrl(base.apiUrl)
    if (urlError) {
      setNotice({ tone: 'warning', scope: 'editor', message: urlError })
      return
    }
    if (!base.apiUrl) {
      setNotice({
        tone: 'warning',
        scope: 'editor',
        message: draftNeedsKey ? t('ai.err.apiUrlEmpty') : t('ai.err.ollamaUrlEmpty'),
      })
      return
    }

    // The first model reuses the current profile ID (editing modifies it), and additional models each become a new profile card.
    const targets: AiProfile[] = models.length === 0
      ? [{ ...draft, ...base, model: '' }]
      : models.map((model, index) => index === 0
        ? { ...draft, ...base, model }
        : { ...blankProfile(draft.provider), ...base, model })

    // Preserve check outcome if the configuration has not changed at all, or preserve the outcome from in-modal testing.
    const withChecks = targets.map((target) => {
      const stored = profiles.find((p) => p.id === target.id)
      const unchanged = stored
        && stored.provider === target.provider
        && stored.apiUrl === target.apiUrl
        && stored.apiKey === target.apiKey
        && stored.model === target.model
      return { ...target, check: target.check ?? (unchanged ? stored.check : undefined) }
    })

    setSaving(true)
    setNotice(null)
    setModelInput('')
    setDraftModels(models)

    const existingIds = new Set(profiles.map((p) => p.id))
    let nextProfiles = profiles.map((p) => withChecks.find((t) => t.id === p.id) ?? p)
    nextProfiles = [...nextProfiles, ...withChecks.filter((t) => !existingIds.has(t.id))]
    // The first newly created profile is activated immediately; editing existing profiles does not hijack the active selection.
    const nextActiveId = draftIsNew ? withChecks[0].id : activeId

    try {
      await persist(nextProfiles, nextActiveId)
    } catch (err) {
      setNotice({ tone: 'error', scope: 'editor', message: t('ai.err.saveFailed'), detail: String(err) })
      setSaving(false)
      return
    }

    const created = withChecks.length
    // Close the editor dialog and report notification on the profile list under the grid.
    setDraft(null)
    setDraftIsNew(false)
    setDraftModels([])
    setModelInput('')
    setAvailableModels([])
    setDraftBaseline('')
    setEngineDraftDirty(false)
    setSaving(false)

    if (draftNeedsKey && !base.apiKey) {
      setNotice({ tone: 'warning', scope: 'list', message: t('ai.msg.savedNoKey', { count: created }) })
      return
    }
    if (models.length === 0) {
      setNotice({ tone: 'warning', scope: 'list', message: t('ai.msg.savedNoModel') })
      return
    }

    setNotice({
      tone: 'success',
      scope: 'list',
      message: created > 1 ? t('ai.msg.savedCount', { count: created }) : t('ai.msg.savedOne'),
      detail: created > 1 ? withChecks.map((t) => t.model).join('\n') : undefined,
    })
  }

  async function handleCheck(profile: AiProfile) {
    if (busy) return
    const scope: Notice['scope'] = draft ? 'editor' : 'list'
    if (!isProfileComplete(profile)) {
      setNotice({
        tone: 'warning',
        scope,
        message: t('ai.msg.incompleteCard', { title: profileTitle(profile) }),
      })
      return
    }

    setCheckingId(profile.id)
    setNotice(null)
    const outcome = await runTest(profile)
    await persist(
      profiles.map((p) => (p.id === profile.id ? { ...p, check: outcomeToCheck(outcome) } : p)),
      activeId,
    )
    if (outcome.ok) {
      setNotice({
        tone: latencyTone(outcome.elapsedMs),
        scope,
        message: successMessage(profile.model, outcome.elapsedMs),
        detail: successDetail(profile, outcome),
      })
    } else {
      setNotice({
        tone: 'error',
        scope,
        message: t('ai.msg.modelFailed', { model: profile.model, message: outcome.message }),
        detail: outcome.detail,
      })
    }
    setCheckingId('')
  }

  async function handleCheckAll() {
    if (busy) return
    const targets = profiles.filter(isProfileComplete)
    const skipped = profiles.length - targets.length
    if (targets.length === 0) {
      setNotice({
        tone: 'warning',
        scope: 'list',
        message: t('ai.msg.nothingToTest'),
      })
      return
    }

    setNotice(null)
    setBatch({ done: 0, total: targets.length })
    setCheckingIds(targets.map((p) => p.id))

    let done = 0
    const results = await Promise.all(targets.map(async (target) => {
      const outcome = await runTest(target)
      done += 1
      setBatch({ done, total: targets.length })
      setCheckingIds((prev) => prev.filter((id) => id !== target.id))
      return { target, outcome }
    }))

    const checks = new Map(results.map((r) => [r.target.id, outcomeToCheck(r.outcome)]))
    await persist(
      profiles.map((p) => {
        const check = checks.get(p.id)
        return check ? { ...p, check } : p
      }),
      activeId,
    )
    setCheckingIds([])
    setBatch(null)

    let okCount = 0
    let failCount = 0
    const lines = results.map(({ target, outcome }) => {
      if (outcome.ok) {
        okCount += 1
        return t('ai.msg.batchLineOk', { model: target.model, latency: formatLatency(outcome.elapsedMs) })
      }
      failCount += 1
      return t('ai.msg.batchLineFail', { model: target.model, message: outcome.message })
    })

    const parts = [t('ai.msg.batchOk', { count: okCount })]
    if (failCount > 0) parts.push(t('ai.msg.batchFail', { count: failCount }))
    if (skipped > 0) parts.push(t('ai.msg.batchSkipped', { count: skipped }))
    if (targets.length > 1) {
      lines.push('', t('ai.msg.batchNote'))
    }

    setNotice({
      tone: failCount > 0 ? 'warning' : 'success',
      scope: 'list',
      message: t('ai.msg.batchDone', { parts: parts.join(t('asr.listSeparator')) }),
      detail: lines.join('\n'),
    })
  }

  function renderCard(profile: AiProfile) {
    const isActive = profile.id === activeId
    const checking = isChecking(profile.id)
    const status = describeStatus(profile, checking)

    return (
      <div
        key={profile.id}
        className={cn(
          'group relative rounded-lg border p-2.5 transition-colors',
          isActive ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/50',
        )}
      >
        <button
          type="button"
          role="radio"
          aria-checked={isActive}
          aria-label={t('common.cardStatusAria', {
            title: profileTitle(profile),
            subtitle: profileSubtitle(profile),
            status: status.spoken,
          })}
          onClick={() => handleActivate(profile.id)}
          className="absolute inset-0 rounded-lg"
        />

        <div className="flex items-center gap-1.5">
          {isActive && (
            <Tooltip className="pointer-events-auto relative z-10 shrink-0" content={t('common.inUse')}>
              <CheckCircle2 className="h-4 w-4 shrink-0 cursor-help text-success-strong" aria-label={t('common.inUse')} />
            </Tooltip>
          )}
          <span className="min-w-0 flex-1 truncate text-xs font-medium" title={profileTitle(profile)}>
            {profileTitle(profile)}
          </span>
          {renderStatusChip(status)}
        </div>

        <div className="mt-1 flex items-center gap-1.5">
          <span
            className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
            title={profile.apiUrl}
          >
            {profileSubtitle(profile)}
          </span>
          <div className="pointer-events-none relative z-10 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            <Tooltip className="pointer-events-auto" content={t('common.test')}>
              <button
                type="button"
                onClick={() => void handleCheck(profile)}
                disabled={busy}
                aria-label={t('ai.testAria', { title: profileTitle(profile) })}
                className={cardIconButtonClass}
              >
                <RefreshCw className={cn('h-3.5 w-3.5', checking && 'animate-spin')} aria-hidden />
              </button>
            </Tooltip>
            <Tooltip className="pointer-events-auto" content={t('common.edit')}>
              <button
                type="button"
                onClick={() => openEditor({ ...profile }, false)}
                aria-label={t('ai.editAria', { title: profileTitle(profile) })}
                className={cardIconButtonClass}
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden />
              </button>
            </Tooltip>
            <Tooltip className="pointer-events-auto" content={t('common.delete')}>
              <button
                type="button"
                onClick={() => setPendingDeleteId(profile.id)}
                aria-label={t('ai.deleteAria', { title: profileTitle(profile) })}
                className={cardIconButtonClass}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
    )
  }

  return (
    <Card>
      <CardContent className="p-6">
        {serverAiSourceLoaded && isServerMode && (
          <section className="mb-4 border-b border-border pb-4" aria-labelledby="server-ai-source-heading">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 id="server-ai-source-heading" className="text-lg font-semibold">
                    {t('ai.serverSource.title')}
                  </h2>
                  <Tooltip variant="light" content={t('ai.serverSource.help')}>
                    <Info
                      aria-label={t('settings.helpAria', { label: t('ai.serverSource.title') })}
                      className={helpIconClass}
                    />
                  </Tooltip>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t(serverAiSource === 'custom' ? 'ai.serverSource.descCustom' : 'ai.serverSource.descManaged')}
                </p>
              </div>
              <Switch
                checked={serverAiSource === 'custom'}
                onChange={() => void handleServerAiSource(serverAiSource === 'custom' ? 'managed' : 'custom')}
                labelledBy="server-ai-source-heading"
                disabled={savingServerAiSource}
              />
            </div>

            {serverAiSourceError && (
              <Feedback className="mt-2" tone="error" message={t('ai.err.saveFailed')} />
            )}
          </section>
        )}

        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 grow basis-[18rem]">
            <div className="flex items-center gap-2">
              <h2 id="ai-service-heading" className="text-lg font-semibold">{t('ai.title')}</h2>
              <Tooltip variant="light" content={pickAdvice()}>
                <Info aria-label={t('ai.helpAria')} className={helpIconClass} />
              </Tooltip>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('ai.desc')}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 shrink-0"
              onClick={() => void handleCheckAll()}
              disabled={busy || profiles.length === 0}
            >
              <RefreshCw className={cn('mr-1 h-3.5 w-3.5', batch && 'animate-spin')} aria-hidden />
              {batch ? t('ai.testingBatch', { done: batch.done, total: batch.total }) : t('ai.testAll')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 shrink-0"
              onClick={() => openEditor(makeDraft(), true)}
            >
              <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
              {t('common.new')}
            </Button>
          </div>
        </div>

        <fieldset className="min-w-0">
          {!loaded ? (
            <p className="py-2 text-sm text-muted-foreground">{t('ai.loading')}</p>
          ) : profiles.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-4 py-4 text-center text-sm text-muted-foreground">
              {t('ai.empty')}
            </p>
          ) : (
            <div
              role="radiogroup"
              aria-labelledby="ai-service-heading"
              className="grid gap-2.5 sm:grid-cols-3"
            >
              {profiles.map(renderCard)}
            </div>
          )}

          {notice?.scope === 'list' && (
            <Feedback className="mt-3" tone={notice.tone} message={notice.message} detail={notice.detail} />
          )}
        </fieldset>
      </CardContent>

      {draft && (
        <Modal
          title={draftIsNew ? t('ai.editorNew') : t('ai.editorEdit')}
          onClose={closeEditor}
          locked={saving || fetchingModels || testingDraft}
          showCloseButton
          panelClassName="w-[520px]"
        >
          <div className="mt-4 space-y-3">
            <div>
              <label htmlFor="ai-provider" className="mb-1 block text-sm text-muted-foreground">{t('ai.provider')}</label>
              <Select
                value={draft.provider}
                onChange={(value) => handleDraftProvider(value)}
                options={aiProvidersForDisplay().map((p) => ({
                  value: p.value,
                  label: p.label,
                }))}
              />
            </div>

            <div>
              <label htmlFor="ai-api-url" className="mb-1 block text-sm text-muted-foreground">
                {draftProvider.keyless ? t('ai.ollamaUrl') : t('ai.apiUrl')}
              </label>
              <input
                id="ai-api-url"
                type="url"
                inputMode="url"
                value={draft.apiUrl}
                onChange={(e) => patchDraft({ apiUrl: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleSave() }}
                placeholder={draftProvider.defaultUrl}
                className={inputClass}
              />
              {draftUrlError && <FormatHint text={draftUrlError} />}
            </div>

            {draftNeedsKey && (
              <div data-modal-autofocus>
                <label htmlFor="ai-api-key" className="mb-1 block text-sm text-muted-foreground">API Key</label>
                <PasswordInput
                  id="ai-api-key"
                  label="API Key"
                  value={draft.apiKey}
                  onChange={(v) => patchDraft({ apiKey: v })}
                  onSubmit={() => void handleSave()}
                  placeholder={t('ai.keyPlaceholder')}
                  className={cn(inputClass, 'pr-8')}
                />
                {!notice && draftKeyHint && <FormatHint text={draftKeyHint} />}
                {draftKeyInherited && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {t('ai.keyReused', { provider: draftProvider.label })}
                  </p>
                )}
                <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
                  {draftProvider.consoleUrl && (
                    <button
                      type="button"
                      onClick={() => void shellOpen(draftProvider.consoleUrl as string)}
                      className={linkClass}
                    >
                      {t('ai.openConsole', { provider: draftProvider.label })}
                      <ExternalLink className="h-3 w-3" aria-hidden />
                    </button>
                  )}
                </div>
              </div>
            )}

            <div>
              <label htmlFor="ai-model" className="mb-1 block text-sm text-muted-foreground">{t('ai.model')}</label>
              {availableModels.length > 0 ? (
                <Select
                  value={selectedModel}
                  onChange={(value) => selectModel(value)}
                  placeholder={t('ai.selectModel')}
                  options={modelOptions.map((model) => ({
                    value: model,
                    label: model,
                  }))}
                />
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <input
                      id="ai-model"
                      value={modelInput}
                      onChange={(e) => { setModelInput(e.target.value); clearDraftCheck(); setNotice(null) }}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') return
                        e.preventDefault()
                        addModel(modelInput)
                      }}
                      placeholder={draftProvider.defaultModels[0] ?? t('ai.modelPlaceholder')}
                      className={cn(inputClass, 'flex-1')}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-9 shrink-0"
                      onClick={() => addModel(modelInput)}
                      disabled={!modelInput.trim()}
                    >
                      {t('ai.addAnother')}
                    </Button>
                  </div>

                  {draftModels.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {draftModels.map((model) => (
                        <span
                          key={model}
                          className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary/50 py-0.5 pl-2 pr-1 text-xs"
                        >
                          {model}
                          <button
                            type="button"
                            onClick={() => removeModel(model)}
                            aria-label={t('ai.removeModel', { model })}
                            className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive-strong"
                          >
                            <X className="h-3 w-3" aria-hidden />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </>
              )}

              <div className="mt-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  onClick={() => void handleFetchModels()}
                  disabled={busy || fetchingModels}
                >
                  <RefreshCw className={cn('mr-1 h-3.5 w-3.5', fetchingModels && 'animate-spin')} aria-hidden />
                  {fetchingModels ? t('ai.fetchingModels') : t('ai.fetchModels')}
                </Button>
              </div>

              <p className="mt-1.5 text-[11px] text-muted-foreground">
                {availableModels.length > 0 ? t('ai.modelSelectHint') : t('ai.multiModelHint')}
              </p>
            </div>

            {notice?.scope === 'editor' && (
              <Feedback tone={notice.tone} message={notice.message} detail={notice.detail} />
            )}

            {/* Dedicated test action on the left allows validating credentials without persisting or closing.
                Cancel and Save actions on the right follow standard modal dialog conventions. */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
              <div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9"
                  onClick={() => void handleTestDraft()}
                  disabled={busy}
                >
                  <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', testingDraft && 'animate-spin')} aria-hidden />
                  {testingDraft ? t('ai.testingConnection') : t('ai.testConnection')}
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9"
                  onClick={closeEditor}
                  disabled={busy}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="h-9"
                  onClick={() => void handleSave()}
                  disabled={busy}
                >
                  {saving ? t('common.saving') : t('common.save')}
                </Button>
              </div>
            </div>
          </div>
        </Modal>
      )}

      {pendingDelete && (
        <Modal title={t('ai.deleteTitle')} onClose={() => setPendingDeleteId('')} panelClassName="w-[420px]">
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            {profileTitle(pendingDelete)} ({profileSubtitle(pendingDelete)}). {t('ai.deleteBody')}
          </p>
          <div className="mt-4 flex items-center justify-end gap-2">
            <Button variant="outline" size="sm" className="h-9" onClick={() => setPendingDeleteId('')}>
              {t('common.cancel')}
            </Button>
            <button
              type="button"
              onClick={() => void handleDelete(pendingDelete.id)}
              className="h-9 rounded-md border border-destructive/30 bg-destructive/5 px-3 text-sm font-medium text-destructive-strong transition-colors hover:bg-destructive/10"
            >
              {t('common.delete')}
            </button>
          </div>
        </Modal>
      )}
    </Card>
  )
}
