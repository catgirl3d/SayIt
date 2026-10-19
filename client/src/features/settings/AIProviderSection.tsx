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
//   - The last grid cell is a dashed "New" tile. It sits outside the radiogroup (the cards are wrapped in a
//     `display: contents` group), so it is not announced as a radio option.
//   - Create / Edit / Delete uses `Modal` (sharing the shell with model directory and deletion dialogs):
//     Includes Escape handling, focus trapping, and focus restoration on close.
//
// Card display criteria focuses on distinguishing cards:
// Model name and provider are always visible; custom hostname is shown only when non-default;
// full URL is available in the edit modal. Latency is the primary benchmark metric and remains visible.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open as shellOpen } from '@tauri-apps/plugin-shell'
import { ExternalLink, Info, Plus, RefreshCw } from 'lucide-react'
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
  applyProviderSwitch,
  blankProfile,
  buildAiProviderConfig,
  checkAiKeyFormat,
  checkApiUrl,
  effectiveApiUrl,
  extractTestReply,
  findProvider,
  formatCheckedAt,
  formatLatency,
  gradeLatency,
  groupedAiProviders,
  isCheckFresh,
  isProfileComplete,
  lastProfileOf,
  newDraftProfile,
  normalizeRemoteModels,
  profileSubtitle,
  profileTitle,
  providerLabel,
  REASONING_EFFORT_OPTIONS,
  resolveActiveProfile,
  SERVICE_TIER_OPTIONS,
  supportsReasoningEffort,
  supportsServiceTier,
  type AiProfile,
  type AiProfileCheck,
  type RemoteModel,
} from './aiProviderCatalog'
import { loadAiProfiles, saveAiProfiles } from './aiProfileStore'
import { ConfirmDeleteModal } from './ConfirmDeleteModal'
import { helpIconClass, inputClass, linkClass } from './formStyles'
import { ModelPicker, RecommendedModels } from './ModelPicker'
import { ProfileCard } from './ProfileCard'
import { useBatchTest, type BatchRunResult } from './useBatchTest'
import { getLocale, t } from '@/i18n'
import { useT } from '@/i18n/useT'

interface TestResult { ok: boolean; message: string; elapsed_ms: number; detail?: string }

interface FetchModelsResult { ok: boolean; models: RemoteModel[]; message: string }

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
    reasoningEffort: draft.reasoningEffort ?? '',
    serviceTier: draft.serviceTier ?? '',
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

interface AIProviderSectionProps {
  /**
   * Lays out the page header around the section's page-level actions (Test all). The actions need
   * this section's state, so the section builds them and the page decides where they go.
   * Defaults to a right-aligned row above the card.
   */
  renderHeader?: (actions: ReactNode) => ReactNode
}

const defaultHeader = (actions: ReactNode) => <div className="mb-3 flex justify-end">{actions}</div>

export default function AIProviderSection({ renderHeader = defaultHeader }: AIProviderSectionProps) {
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
  /** The model field and its Load button: the model list spans this whole row, not just the field. */
  const modelRowRef = useRef<HTMLDivElement>(null)
  /** Remote models are a temporary selector catalog, not persisted profiles. */
  const [availableModels, setAvailableModels] = useState<RemoteModel[]>([])
  /** Whether the model catalog is being fetched from the endpoint. */
  const [fetchingModels, setFetchingModels] = useState(false)
  /** Snapshot taken when opening the modal, used to determine unsaved changes */
  const [draftBaseline, setDraftBaseline] = useState('')
  const [saving, setSaving] = useState(false)
  /** Another card is being switched active; also disables the other write paths. */
  const [activating, setActivating] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [testingDraft, setTestingDraft] = useState(false)
  const [checkingId, setCheckingId] = useState('')
  const [pendingDeleteId, setPendingDeleteId] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [serverAiSource, setServerAiSource] = useState<ServerAiSource>('managed')
  const [savingServerAiSource, setSavingServerAiSource] = useState(false)
  const [serverAiSourceError, setServerAiSourceError] = useState(false)
  const [serverAiSourceLoaded, setServerAiSourceLoaded] = useState(false)
  const [isServerMode, setIsServerMode] = useState(false)

  /**
   * Batch "test all" runner. Its commit callback persists the collected checks
   * and posts the summary while the batch state still keeps the page busy.
   */
  const { batch, isRunning, runBatch } = useBatchTest<AiProfile, TestOutcome>({
    runOne: runTest,
    commit: commitBatchResults,
  })

  const draftProvider = findProvider(draft?.provider ?? '')
  const draftNeedsKey = !draftProvider.keyless
  const draftUrlError = draft ? checkApiUrl(draft.apiUrl) : ''
  const draftKeyHint = draft && draftNeedsKey ? checkAiKeyFormat(draft.provider, draft.apiKey) : ''
  /**
   * The models this submit will save. A new service collects chips (`draftModels`) and may save
   * several, one card each, plus a name typed but not yet committed. An existing card holds one
   * model, and the field's text is that model (`draftModels` stays empty). `draft.model` is never
   * read for this, so the chips and the field text are the only source of truth.
   */
  const pendingModels = ((): string[] => {
    const typed = modelInput.trim()
    if (!draftIsNew) return typed ? [typed] : []
    if (!typed || draftModels.includes(typed)) return draftModels
    return [...draftModels, typed]
  })()
  const draftSignature = draft ? draftSnapshot(draft, pendingModels) : ''
  const draftDirty = draft !== null && draftSignature !== draftBaseline
  const draftKeyInherited = draft !== null
    && draftIsNew
    && draft.apiKey.trim() !== ''
    && lastProfileOf(profiles, draft.provider)?.apiKey === draft.apiKey
  const busy = saving || activating || deleting || fetchingModels || testingDraft || checkingId !== '' || batch !== null
  const isChecking = (id: string) => checkingId === id || isRunning(id)
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

  // Write first, commit the state second: a failed save must not leave the list
  // showing a selection that was never persisted (same semantics as the ASR store).
  async function persist(nextProfiles: AiProfile[], nextActiveId: string) {
    const active = resolveActiveProfile(nextProfiles, nextActiveId)
    try {
      await saveAiProfiles({ profiles: nextProfiles, activeId: nextActiveId })
    } catch (error) {
      // A transaction can commit before its IPC acknowledgement fails. Re-read the
      // saved state before reporting the error rather than assuming nothing changed.
      try {
        const state = await loadAiProfiles()
        setProfiles(state.profiles)
        setActiveId(state.activeId)
      } catch {
        // Best-effort reconciliation: the save failure stays the error to report.
      }
      throw error
    }
    setProfiles(nextProfiles)
    setActiveId(active?.id ?? '')
  }

  function openEditor(profile: AiProfile, isNew: boolean) {
    const model = profile.model.trim()
    // The baseline lists what the field would save untouched, so only a real change makes the draft dirty.
    const models = !isNew && model ? [model] : []
    setDraft(profile)
    setDraftIsNew(isNew)
    setDraftModels([])
    setModelInput(isNew ? '' : model)
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

  /** A new service collects models as chips; picking from the list in an existing card swaps its one model. */
  function addModel(name: string) {
    const value = name.trim()
    setNotice(null)
    if (!draftIsNew) {
      if (!value || value === modelInput.trim()) return
      setModelInput(value)
      clearDraftCheck()
      return
    }
    setModelInput('')
    if (value && !draftModels.includes(value)) setDraftModels([...draftModels, value])
  }

  function removeModel(name: string) {
    setDraftModels(draftModels.filter((m) => m !== name))
    clearDraftCheck()
    setNotice(null)
  }

  /**
   * Load a temporary model catalog for the configured chat endpoint.
   * The catalog is kept separate from draftModels: each fetched name is an option, not a new profile.
   */
  async function handleFetchModels() {
    if (!draft || busy) return
    const apiUrl = effectiveApiUrl(draft.provider, draft.apiUrl)
    const urlError = checkApiUrl(apiUrl)
    if (urlError) {
      setNotice({ tone: 'warning', scope: 'editor', message: urlError })
      return
    }
    if (!apiUrl) {
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
          api_url: apiUrl,
          api_key: draft.apiKey,
          model: '',
        },
      })
      if (!result.ok) {
        const friendly = describeProviderError(result.message)
        setNotice({ tone: 'error', scope: 'editor', message: friendly.message, detail: friendly.detail })
        return
      }
      const models = normalizeRemoteModels(result.models)
      if (models.length === 0) {
        setNotice({ tone: 'warning', scope: 'editor', message: t('ai.msg.noModels') })
        return
      }
      setAvailableModels(models)
      setNotice({ tone: 'success', scope: 'editor', message: t('ai.msg.modelsLoaded', { count: models.length }) })
    } catch (err) {
      const friendly = describeProviderError(err)
      setNotice({ tone: 'error', scope: 'editor', message: friendly.message, detail: friendly.detail })
    } finally {
      setFetchingModels(false)
    }
  }

  async function handleActivate(id: string) {
    // Serialize with every other write path: a second activation (or any state change
    // while a save is in flight) would persist a list that is already out of date.
    if (id === activeId || busy) return
    setNotice(null)
    setActivating(true)
    try {
      await persist(profiles, id)
    } catch (err) {
      const friendly = describeProviderError(err)
      setNotice({
        tone: 'error',
        scope: 'list',
        message: t('ai.msg.activationFailed', { message: friendly.message }),
        detail: friendly.detail,
      })
    } finally {
      setActivating(false)
    }
  }

  async function handleDelete(id: string) {
    if (busy) return
    setDeleting(true)
    const next = profiles.filter((p) => p.id !== id)
    setPendingDeleteId('')
    if (draft?.id === id) closeEditor()
    setNotice(null)
    try {
      await persist(next, id === activeId ? '' : activeId)
    } catch (err) {
      const friendly = describeProviderError(err)
      setNotice({
        tone: 'error',
        scope: 'list',
        message: t('ai.msg.deleteFailed', { message: friendly.message }),
        detail: friendly.detail,
      })
    } finally {
      setDeleting(false)
    }
  }

  function handleDraftProvider(value: string) {
    if (!draft) return
    const next = applyProviderSwitch(draft, draftIsNew ? draftModels : pendingModels, value, profiles)
    if (draftIsNew) setDraftModels(next.models)
    else setModelInput(next.models[0] ?? '')
    setAvailableModels([])
    setDraft({ ...draft, provider: next.provider, apiUrl: next.apiUrl, apiKey: next.apiKey, check: undefined })
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

  async function runTest(profile: AiProfile): Promise<TestOutcome> {
    try {
      const result = await invoke<TestResult>('test_ai_connection', {
        config: buildAiProviderConfig(profile),
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
      apiUrl: effectiveApiUrl(draft.provider, draft.apiUrl),
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

    const testModel = pendingModels[0] ?? ''
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

    // A model name typed without pressing Enter still counts.
    const models = pendingModels

    const base = {
      provider: draft.provider,
      apiUrl: effectiveApiUrl(draft.provider, draft.apiUrl),
      apiKey: draft.apiKey.trim(),
      reasoningEffort: draft.reasoningEffort,
      serviceTier: draft.serviceTier,
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
        && (stored.reasoningEffort ?? '') === (target.reasoningEffort ?? '')
        && (stored.serviceTier ?? '') === (target.serviceTier ?? '')
      return { ...target, check: target.check ?? (unchanged ? stored.check : undefined) }
    })

    setSaving(true)
    setNotice(null)
    // Commit the collected names into the field's own state, so a failed save keeps them on screen.
    if (draftIsNew) {
      setModelInput('')
      setDraftModels(models)
    } else {
      setModelInput(models[0] ?? '')
    }

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
    try {
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
    } catch (err) {
      // runTest folds recognition failures into outcomes, so a throw here means the
      // verdict could not be persisted. The card must not stay in the testing state.
      setNotice({ tone: 'error', scope, message: t('ai.err.saveFailed'), detail: String(err) })
    } finally {
      setCheckingId('')
    }
  }

  /**
   * Persist the collected checks and post the batch summary. Runs inside the
   * batch runner before its state is cleared, so the page stays busy until the
   * write actually finishes.
   */
  async function commitBatchResults(results: BatchRunResult<AiProfile, TestOutcome>[]) {
    const checks = new Map(results.map(({ item, result }) => [item.id, outcomeToCheck(result)]))
    await persist(
      profiles.map((p) => {
        const check = checks.get(p.id)
        return check ? { ...p, check } : p
      }),
      activeId,
    )

    let okCount = 0
    let failCount = 0
    const lines = results.map(({ item, result }) => {
      if (result.ok) {
        okCount += 1
        return t('ai.msg.batchLineOk', { model: item.model, latency: formatLatency(result.elapsedMs) })
      }
      failCount += 1
      return t('ai.msg.batchLineFail', { model: item.model, message: result.message })
    })

    const skipped = profiles.length - results.length
    const parts = [t('ai.msg.batchOk', { count: okCount })]
    if (failCount > 0) parts.push(t('ai.msg.batchFail', { count: failCount }))
    if (skipped > 0) parts.push(t('ai.msg.batchSkipped', { count: skipped }))
    if (results.length > 1) {
      lines.push('', t('ai.msg.batchNote'))
    }

    setNotice({
      tone: failCount > 0 ? 'warning' : 'success',
      scope: 'list',
      message: t('ai.msg.batchDone', { parts: parts.join(t('asr.listSeparator')) }),
      detail: lines.join('\n'),
    })
  }

  async function handleCheckAll() {
    if (busy) return
    const targets = profiles.filter(isProfileComplete)
    if (targets.length === 0) {
      setNotice({
        tone: 'warning',
        scope: 'list',
        message: t('ai.msg.nothingToTest'),
      })
      return
    }

    setNotice(null)
    try {
      await runBatch(targets)
    } catch (err) {
      setNotice({ tone: 'error', scope: 'list', message: t('ai.err.saveFailed'), detail: String(err) })
    }
  }

  function renderCard(profile: AiProfile) {
    const checking = isChecking(profile.id)
    const status = describeStatus(profile, checking)

    return (
      <ProfileCard
        key={profile.id}
        active={profile.id === activeId}
        onActivate={() => void handleActivate(profile.id)}
        activateDisabled={busy}
        ariaLabel={t('common.cardStatusAria', {
          title: profileTitle(profile),
          subtitle: profileSubtitle(profile),
          status: status.spoken,
        })}
        title={profileTitle(profile)}
        subtitle={profileSubtitle(profile)}
        subtitleTitle={profile.apiUrl}
        statusChip={renderStatusChip(status)}
        test={{
          ariaLabel: t('ai.testAria', { title: profileTitle(profile) }),
          onClick: () => void handleCheck(profile),
          disabled: busy,
          spinning: checking,
        }}
        edit={{
          ariaLabel: t('ai.editAria', { title: profileTitle(profile) }),
          onClick: () => openEditor({ ...profile }, false),
          disabled: activating,
        }}
        delete={{
          ariaLabel: t('ai.deleteAria', { title: profileTitle(profile) }),
          onClick: () => setPendingDeleteId(profile.id),
          disabled: busy,
        }}
      />
    )
  }

  const testAllButton = (
    <Button
      variant="outline"
      size="sm"
      className="shrink-0"
      onClick={() => void handleCheckAll()}
      disabled={busy || profiles.length === 0}
    >
      <RefreshCw className={cn('mr-1 h-3.5 w-3.5', batch && 'animate-spin')} aria-hidden />
      {batch ? t('ai.testingBatch', { done: batch.done, total: batch.total }) : t('ai.testAll')}
    </Button>
  )

  // Doubles as the empty state: with no cards it spans the row and carries the "no services" note.
  const noProfiles = profiles.length === 0
  const newServiceTile = (
    <button
      type="button"
      onClick={() => openEditor(newDraftProfile(profiles, activeId), true)}
      aria-label={noProfiles ? t('common.new') : undefined}
      aria-describedby={noProfiles ? 'ai-service-empty' : undefined}
      className={cn(
        'flex min-h-16 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border px-3 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        noProfiles && 'py-5 sm:col-span-3',
      )}
    >
      <span className="flex items-center gap-1.5">
        <Plus className="h-3.5 w-3.5" aria-hidden />
        {t('common.new')}
      </span>
      {noProfiles && <span id="ai-service-empty">{t('ai.empty')}</span>}
    </button>
  )

  return (
    <>
      {renderHeader(testAllButton)}
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

          <fieldset className="min-w-0">
            {!loaded ? (
              <p className="py-2 text-sm text-muted-foreground">{t('ai.loading')}</p>
            ) : (
              <div className="grid gap-2.5 sm:grid-cols-3">
                {!noProfiles && (
                  <div role="radiogroup" aria-label={t('ai.title')} className="contents">
                    {profiles.map(renderCard)}
                  </div>
                )}
                {newServiceTile}
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
                  options={groupedAiProviders().map(({ provider, group }) => ({
                    value: provider.value,
                    label: provider.label,
                    group,
                  }))}
                />
              </div>

              <div>
                <label htmlFor="ai-api-url" className="mb-1 block text-sm text-muted-foreground">
                  {draftProvider.urlOptional ? t('ai.apiUrlOptional') : draftProvider.keyless ? t('ai.ollamaUrl') : t('ai.apiUrl')}
                </label>
                <input
                  id="ai-api-url"
                  type="url"
                  inputMode="url"
                  value={draft.apiUrl}
                  onChange={(e) => patchDraft({ apiUrl: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Enter') void handleSave() }}
                  placeholder={draftProvider.defaultUrl}
                  aria-describedby={draftProvider.urlOptional ? 'ai-api-url-hint' : undefined}
                  className={inputClass}
                />
                {draftProvider.urlOptional && (
                  <p id="ai-api-url-hint" className="mt-1 text-xs text-muted-foreground">{t('ai.apiUrlOptionalHint')}</p>
                )}
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
                <label htmlFor="ai-model" className="mb-1 block text-sm text-muted-foreground">
                  {t('ai.model')}
                </label>
                <div ref={modelRowRef} className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <ModelPicker
                      models={availableModels}
                      value={draftModels}
                      multiple={draftIsNew}
                      onAdd={addModel}
                      onRemove={removeModel}
                      inputValue={modelInput}
                      onInputChange={(text) => { setModelInput(text); clearDraftCheck(); setNotice(null) }}
                      inputId="ai-model"
                      anchorRef={modelRowRef}
                      recommended={draftProvider.recommendedModels}
                      placeholder={draftIsNew && draftModels.length > 0 ? t('ai.modelAddPlaceholder') : t('ai.modelPlaceholder')}
                    />
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-9 shrink-0"
                    onClick={() => void handleFetchModels()}
                    disabled={busy || fetchingModels}
                  >
                    <RefreshCw className={cn('mr-1 h-3.5 w-3.5', fetchingModels && 'animate-spin')} aria-hidden />
                    {fetchingModels ? t('ai.fetchingModels') : t('ai.fetchModels')}
                  </Button>
                </div>

                <RecommendedModels
                  models={draftProvider.recommendedModels ?? []}
                  chosen={pendingModels}
                  onPick={addModel}
                  disabled={busy}
                />
                {draftIsNew && <p className="mt-1.5 text-[11px] text-muted-foreground">{t('ai.multiModelHint')}</p>}
              </div>

              {/* Request tuning, per capability. Hidden for providers whose endpoints would
                  reject the field — generic OpenAI-compatible endpoints may reject unknown
                  body fields, and OpenCode Zen/Go has no service tiers. */}
              {(supportsReasoningEffort(draft.provider) || supportsServiceTier(draft.provider)) && (
                <div className="grid grid-cols-2 gap-3">
                  {supportsReasoningEffort(draft.provider) && (
                    <div>
                      <span id="ai-reasoning-effort-label" className="mb-1 block text-sm text-muted-foreground">
                        {t('ai.reasoningEffort')}
                      </span>
                      <Select
                        value={draft.reasoningEffort ?? ''}
                        onChange={(value) => patchDraft({ reasoningEffort: value || undefined })}
                        labelledBy="ai-reasoning-effort-label"
                        options={[
                          { value: '', label: t('ai.tuningUnset') },
                          ...REASONING_EFFORT_OPTIONS.map((value) => ({ value, label: value })),
                        ]}
                      />
                      <p className="mt-1 text-[11px] text-muted-foreground">{t('ai.reasoningEffortHint')}</p>
                    </div>
                  )}
                  {supportsServiceTier(draft.provider) && (
                    <div>
                      <span id="ai-service-tier-label" className="mb-1 block text-sm text-muted-foreground">
                        {t('ai.serviceTier')}
                      </span>
                      <Select
                        value={draft.serviceTier ?? ''}
                        onChange={(value) => patchDraft({ serviceTier: value || undefined })}
                        labelledBy="ai-service-tier-label"
                        options={[
                          { value: '', label: t('ai.tuningUnset') },
                          ...SERVICE_TIER_OPTIONS.map((value) => ({ value, label: value })),
                        ]}
                      />
                      <p className="mt-1 text-[11px] text-muted-foreground">{t('ai.serviceTierHint')}</p>
                    </div>
                  )}
                </div>
              )}

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
                    {saving
                      ? t('common.saving')
                      : pendingModels.length > 1
                        ? t('ai.saveCount', { count: pendingModels.length })
                        : t('common.save')}
                  </Button>
                </div>
              </div>
            </div>
          </Modal>
        )}

        {pendingDelete && (
          <ConfirmDeleteModal
            title={t('ai.deleteTitle')}
            danger
            body={`${profileTitle(pendingDelete)} (${profileSubtitle(pendingDelete)}). ${t('ai.deleteBody')}`}
            onCancel={() => setPendingDeleteId('')}
            onConfirm={() => void handleDelete(pendingDelete.id)}
          />
        )}
      </Card>
    </>
  )
}
