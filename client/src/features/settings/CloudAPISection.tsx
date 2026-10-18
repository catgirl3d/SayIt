// Cloud API mode settings panel — one card = one speech recognition service configuration.
//
// Structure mirrors the AI Services page (same card anatomy, same dialogs, same state
// semantics): several profiles can be stored, including multiple ones for a vendor
// (two Bailian accounts, two Doubao key sets), and clicking a card activates it.
//
// The one substantive difference from AI services: the provider comes from a built-in
// catalog and arbitrary URLs cannot be entered — every ASR vendor's protocol needs a
// dedicated Rust implementation, unlike AI cleanup, which only needs an
// OpenAI-compatible endpoint.
//
// "Pasting the same key twice for one platform" is not solved by lifting credentials to
// platform level (that would stop a card from being one complete configuration, and two
// accounts could not be stored). It follows the AI services approach instead: a newly
// created profile inherits the key of the previous profile on the same platform, and the
// UI says where it came from.

import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open as shellOpen } from '@tauri-apps/plugin-shell'
import { ExternalLink, Info, Plus, RefreshCw } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Feedback, FormatHint, type FeedbackTone } from '@/components/ui/feedback'
import { Modal } from '@/components/ui/modal'
import { PasswordInput } from '@/components/ui/password-input'
import { Segmented } from '@/components/ui/segmented'
import { Select } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { refreshModeStatus } from '@/stores/modeStatus'
import { setEngineDraftDirty } from '@/stores/engineDraft'
import { getCloudAsrSupportedLanguages } from '@/lib/asrModels'
import type { SpeechInputLanguage } from '@/services/speechInputLanguage'
import { describeProviderError } from '@/lib/errorMessages'
import { doubaoKeyLabel } from '@/lib/cloudAsrCreds'
import { prepareTestPcm, type PreparedTestAudio } from './testAudio'
import {
  ASR_PLATFORMS,
  asrAvailabilityLabel,
  asrProfileCheckShouldInvalidate,
  changeAsrProfileProvider,
  describeAsrMissing,
  buildAsrProviderConfig,
  CUSTOM_ASR_PROVIDER,
  emptyAsrProfile,
  findAsrProvider,
  gradeAsrLatency,
  groupedAsrProviders,
  keyFingerprint,
  normalizeAsrProfileForSave,
  type AsrCheck,
  type AsrProfile,
} from './asrProviderCatalog'
import { loadAsrProfiles, saveAsrProfileChecks, saveAsrProfiles } from './asrProfileStore'
import { ConfirmDeleteModal } from './ConfirmDeleteModal'
import { helpIconClass, inputClass, linkClass } from './formStyles'
import { ProfileCard } from './ProfileCard'
import { useBatchTest, type BatchRunResult } from './useBatchTest'
import { formatCheckedAt, formatLatency, isCheckFresh } from './aiProviderCatalog'
import { t, type TranslationKey } from '@/i18n'
import { useT } from '@/i18n/useT'
import { transcribeCustomAsr } from '@/services/transcription/customAsrRequest'

const DOUBAO_CONSOLE_OPTIONS = [
  { value: 'new', labelKey: 'asr.console.new' },
  { value: 'legacy', labelKey: 'asr.console.legacy' },
] as const

// ⚠️ The two blocks below are System Prompts SENT TO THE MODEL, not UI copy, so they
// deliberately stay out of the locale files. The prompt language follows what the user
// speaks, not the interface language — a literal translation into English would degrade
// cleanup quality for Chinese dictation. The English prompt set is a separate concern.
const DEFAULT_OMNI_PROMPT = 'You are a speech-to-text transcription assistant. Accurately transcribe the user speech, maintaining the original meaning and spoken language with proper punctuation. Do not add extra explanations or commentary.'

const OMNI_PROMPT_POLISH = `You are a speech-to-text refinement assistant. The input is raw ASR transcription. Your task is to clean it into clear, accurate, and concise text.
Core principles: Preserve all user information and intent, remove speech fillers, and fix recognition typos.
Rules:
1. Remove meaningless speech fillers and stuttering.
2. Recognize speech self-corrections and output only the final intended version.
3. Fix obvious recognition errors in technical terms, names, and capitalization.
4. Add accurate punctuation.
5. If structured points (first, second, next) are present, format as an ordered list.
Constraints: Do not alter the core meaning. Do not answer, explain, or continue the user's statements.
Output ONLY the refined text.`

const OMNI_PROMPT_PRESETS = [
  { value: DEFAULT_OMNI_PROMPT, labelKey: 'asr.omniPreset.faithful' },
  { value: OMNI_PROMPT_POLISH, labelKey: 'asr.omniPreset.polish' },
] as const satisfies readonly { value: string; labelKey: TranslationKey }[]

interface Notice {
  tone: FeedbackTone
  message: string
  detail?: string
  /**
   * Where the message belongs. Editor-scoped messages must render inside the editor
   * modal — the page notice sits behind the overlay and the user would never see it.
   * Older call sites omit the scope and keep rendering on the page.
   */
  scope?: 'list' | 'editor'
}

/**
 * Outcome of one recognition test. `check` is written back to the card on success AND
 * failure — a failed test must show "unavailable" on the card, not stay at "untested"
 * as if it had never been run.
 */
type AsrTestOutcome =
  | { ok: true; check: AsrCheck; text: string; latencyMs: number; audioSec: number }
  | { ok: false; check: AsrCheck; message: string; detail?: string }

/**
 * Run one recognition pass and collect the outcome.
 *
 * Deliberately touches no state and writes no storage: the single-card test and
 * "Test all" share it, and each caller decides how to persist the check and what
 * to show. The message carries no provider name; callers add their own prefix.
 */
async function runAsrTest(
  profile: AsrProfile,
  audio: { pcmB64: string; audioSec: number },
  language: SpeechInputLanguage,
): Promise<AsrTestOutcome> {
  const entry = findAsrProvider(profile.provider)
  if (!entry) {
    return { ok: false, check: { ok: false, at: Date.now(), reason: t('asr.err.unknownProvider') }, message: t('asr.err.unknownProvider') }
  }
  try {
    const start = performance.now()
    const r = profile.provider === CUSTOM_ASR_PROVIDER
      ? await transcribeCustomAsr({
        profile,
        audioB64: audio.pcmB64,
        sampleRate: 16000,
        language,
        hotwords: [],
        isCurrent: () => true,
      })
      : await invoke<{ text: string; elapsed_ms: number }>('cloud_transcribe', {
        request: {
          audio_b64: audio.pcmB64,
          sample_rate: 16000,
          asr_config: buildAsrProviderConfig(profile, language),
        },
      })
    if (!r) throw new Error(t('asr.msg.testCanceled'))
    const latencyMs = Math.round(performance.now() - start)
    const text = r.text.trim()
    if (!text) {
      // Connected but nothing came out. The clip matches the selected language,
      // so the service or the account is the likely cause.
      return {
        ok: false,
        check: { ok: false, at: Date.now(), reason: t('asr.err.emptyText') },
        message: t('asr.msg.emptyText'),
      }
    }
    return {
      ok: true,
      check: { ok: true, at: Date.now(), latencyMs, audioSec: audio.audioSec },
      text,
      latencyMs,
      audioSec: audio.audioSec,
    }
  } catch (err) {
    const friendly = describeProviderError(err)
    return {
      ok: false,
      check: { ok: false, at: Date.now(), reason: friendly.message },
      message: t('asr.msg.testFailed', { message: friendly.message }),
      detail: friendly.detail,
    }
  }
}

/** Card title: append the key fingerprint when a vendor has several profiles, otherwise the cards would look identical */
function profileTitle(profile: AsrProfile, siblings: number): string {
  const entry = findAsrProvider(profile.provider)
  const base = entry?.label ?? profile.provider
  if (siblings <= 1) return base
  const fp = keyFingerprint(profile)
  return fp ? `${base} ${fp}` : base
}

export default function CloudAPISection({ speechLanguage }: { speechLanguage: SpeechInputLanguage }) {
  useT()
  const [profiles, setProfiles] = useState<AsrProfile[]>([])
  const [activeId, setActiveId] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [testingId, setTestingId] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [pendingDeleteId, setPendingDeleteId] = useState('')

  /**
   * Batch "Test all" runner. Its commit callback persists the collected checks and
   * posts the summary while the batch state still keeps the page busy.
   */
  const { batch, isRunning, runBatch } = useBatchTest<AsrProfile, AsrTestOutcome, PreparedTestAudio>({
    prepare: () => prepareTestPcm(speechLanguage),
    runOne: (profile, audio) => runAsrTest(profile, audio, speechLanguage),
    commit: commitBatchResults,
  })

  /** The profile being edited (new profiles go through here too). null = dialog closed */
  const [draft, setDraft] = useState<AsrProfile | null>(null)
  const [draftIsNew, setDraftIsNew] = useState(false)
  const [draftBaseline, setDraftBaseline] = useState('')
  const [saving, setSaving] = useState(false)
  const [activating, setActivating] = useState(false)

  const busy = testingId !== '' || saving || activating || batch !== null
  const activeProvider = profiles.find((profile) => profile.id === activeId)?.provider
  const supportedLanguages = activeProvider ? getCloudAsrSupportedLanguages(activeProvider) : null
  const sendsLanguageHint = activeProvider === 'openai_transcribe'
    || activeProvider === 'gemini_transcribe'
    || activeProvider === 'openrouter_transcribe'
    || activeProvider === CUSTOM_ASR_PROVIDER
  /** Is this card testing right now — both single-card and concurrent batch runs count */
  const isTesting = (id: string) => testingId === id || isRunning(id)
  const draftEntry = draft ? findAsrProvider(draft.provider) : undefined
  const draftPlatform = draftEntry?.platform ?? 'doubao'
  const draftIsDoubao = draftPlatform === 'doubao'
  const draftDirty = draft !== null && JSON.stringify(draft) !== draftBaseline
  /**
   * Whether the key was inherited from the previous profile on the same platform.
   * Decided by "the current value still equals that profile's key": as soon as the
   * user types something else, the hint disappears on its own.
   */
  const draftKeyInherited = draft !== null
    && draftIsNew
    && draft.apiKey.trim() !== ''
    && lastProfileOfPlatform(draft.provider, draft.id)?.apiKey === draft.apiKey

  useEffect(() => {
    void load()
    return () => setEngineDraftDirty(false)
  }, [])

  async function load() {
    const state = await loadAsrProfiles()
    setProfiles(state.profiles)
    setActiveId(state.activeId)
    setLoaded(true)
  }

  /** The most recent profile on the same platform, used to inherit the key on create */
  function lastProfileOfPlatform(providerId: string, excludeId?: string): AsrProfile | undefined {
    const platform = findAsrProvider(providerId)?.platform
    if (!platform) return undefined
    return [...profiles]
      .reverse()
      .find((p) => p.id !== excludeId && findAsrProvider(p.provider)?.platform === platform)
  }

  async function persist(next: AsrProfile[], nextActiveId: string) {
    const committed = await saveAsrProfiles({ profiles: next, activeId: nextActiveId })
    setProfiles(committed.profiles)
    setActiveId(committed.activeId)
    void refreshModeStatus()
  }

  async function persistChecks(updates: Array<{ profile: AsrProfile; check: AsrCheck }>) {
    const state = await saveAsrProfileChecks(updates.map((update) => ({
      ...update,
      profile: normalizeAsrProfileForSave(update.profile),
    })))
    setProfiles(state.profiles)
    setActiveId(state.activeId)
    void refreshModeStatus()
  }

  async function handleActivate(id: string) {
    if (id === activeId || activating) return
    setActivating(true)
    setNotice({ tone: 'info', message: t('asr.msg.activationPending') })
    try {
      await persist(profiles, id)
      setNotice(null)
    } catch (err) {
      const friendly = describeProviderError(err)
      setNotice({
        tone: 'error',
        message: t('asr.msg.activationFailed', { message: friendly.message }),
        detail: friendly.detail,
      })
    } finally {
      setActivating(false)
    }
  }

  // ───────────────────────── Tests ─────────────────────────

  /**
   * Run one real recognition pass with the bundled test clip.
   *
   * Why not the cheaper test_asr_connection: it only performs a handshake/auth check,
   * and recognition can still fail after a passing handshake (resource not enabled,
   * quota exhausted); it also cannot measure latency. This page must answer "which one
   * is faster", so it has to run real transcription. The cost is one real billable
   * call, and the page discloses that.
   */
  async function handleTest(profile: AsrProfile) {
    if (busy) return
    const entry = findAsrProvider(profile.provider)
    if (!entry) return
    const missing = describeAsrMissing(profile)
    if (missing) {
      setNotice({ tone: 'warning', message: t('asr.msg.missingBeforeTest', { label: entry.label, missing }) })
      return
    }
    setTestingId(profile.id)
    setNotice(null)
    try {
      let outcome: AsrTestOutcome
      try {
        outcome = await runAsrTest(profile, await prepareTestPcm(speechLanguage), speechLanguage)
      } catch (err) {
        // Only the test-clip preparation reaches here; recognition failures are folded into outcomes by runAsrTest
        const friendly = describeProviderError(err)
        setNotice({ tone: 'error', message: t('asr.msg.testCrashed', { label: entry.label, message: friendly.message }), detail: friendly.detail })
        return
      }

      try {
        await persistChecks([{ profile, check: outcome.check }])
      } catch (err) {
        // The recognition ran and was billed; only its verdict could not be stored. Reporting it
        // as "the test didn't run" would invite a second paid run.
        const friendly = describeProviderError(err)
        setNotice({ tone: 'error', message: t('asr.msg.testSaveFailed', { message: friendly.message }), detail: friendly.detail })
        return
      }

      if (!outcome.ok) {
        setNotice({ tone: 'error', message: `${entry.label} ${outcome.message}`, detail: outcome.detail })
        return
      }
      const grade = gradeAsrLatency(outcome.latencyMs, outcome.audioSec)
      setNotice({
        tone: grade.tone === 'bad' ? 'warning' : 'success',
        message: t('asr.msg.testOk', { label: entry.label, sec: outcome.audioSec.toFixed(1), latency: formatLatency(outcome.latencyMs), grade: grade.label }),
        detail: t('asr.msg.testDetail', { text: outcome.text }),
      })
    } finally {
      setTestingId('')
    }
  }

  /**
   * Persist the collected checks and post the batch summary. Runs inside the batch
   * runner before its state is cleared, so the page stays busy until the write actually
   * finishes.
   *
   * The batch runs its recognition passes CONCURRENTLY on a single click (no second
   * confirmation). Know the costs before switching back to serial execution: the card
   * timings exist to compare "which one is faster", and concurrent numbers pollute each
   * other — especially cards on the same platform (the Qwen variants share one Bailian
   * key and hit the same service) — and they can trip rate limits that get recorded as
   * "unavailable". That is why the summary notes its timings are not comparable; for
   * trustworthy numbers use the per-card test.
   *
   * The checks are persisted in one write, not per card: under concurrency every
   * callback sees the same stale profiles list, so per-card persists would overwrite
   * each other and keep only the last verdict. The cost is that closing the page
   * mid-batch loses the whole batch — after parallelization the batch only waits for
   * the slowest card, so that window is very short.
   *
   * Also: profiles missing configuration are skipped rather than marked "unavailable".
   * What they lack is a key, not availability; the summary reports how many were skipped.
   */
  async function commitBatchResults(results: BatchRunResult<AsrProfile, AsrTestOutcome>[]) {
    // The test clip was prepared once and shared by every card by the batch runner
    await persistChecks(results.map(({ item, result }) => ({ profile: item, check: result.check })))

    let okCount = 0
    let failCount = 0
    const lines = results.map(({ item, result }) => {
      const label = findAsrProvider(item.provider)?.label ?? item.provider
      if (result.ok) {
        okCount += 1
        const grade = gradeAsrLatency(result.latencyMs, result.audioSec)
        return t('asr.msg.batchLine', { label, latency: formatLatency(result.latencyMs), grade: grade.label })
      }
      failCount += 1
      return `${label}: ${result.message}`
    })

    const skipped = profiles.length - results.length
    const parts = [t('asr.msg.batchOk', { count: okCount })]
    if (failCount > 0) parts.push(t('asr.msg.batchFail', { count: failCount }))
    if (skipped > 0) parts.push(t('asr.msg.batchSkipped', { count: skipped }))
    if (results.length > 1) {
      lines.push('', t('asr.msg.batchNote'))
    }
    setNotice({
      tone: failCount > 0 ? 'warning' : 'success',
      // The separator also comes from the locale: Chinese uses "，", English ", "
      message: t('asr.msg.batchDone', { parts: parts.join(t('asr.listSeparator')) }),
      detail: lines.join('\n'),
    })
  }

  async function handleTestAll() {
    if (busy) return
    const targets = profiles.filter((p) => !describeAsrMissing(p))
    if (targets.length === 0) {
      setNotice({
        tone: 'warning',
        message: t('asr.msg.nothingToTest'),
      })
      return
    }

    setNotice(null)
    try {
      await runBatch(targets)
    } catch (err) {
      // Only the shared test-clip preparation fails this way; recognition failures are
      // folded into outcomes by runAsrTest. A persist failure inside the commit also
      // lands here, same as the previous single try block.
      const friendly = describeProviderError(err)
      setNotice({ tone: 'error', message: t('asr.msg.batchCrashed', { message: friendly.message }), detail: friendly.detail })
    }
  }

  // ───────────────────── New / Edit ─────────────────────

  function openEditor(profile: AsrProfile, isNew: boolean) {
    setDraft(profile)
    setDraftIsNew(isNew)
    setDraftBaseline(JSON.stringify(profile))
    setNotice(null)
  }

  function handleNew() {
    const fresh = emptyAsrProfile()
    // Inherit the key when the same platform already has a profile: the most common
    // operation is "same account, another model, save one more card", and this spares
    // the user another copy-paste trip to the console.
    const prev = lastProfileOfPlatform(fresh.provider, fresh.id)
    if (prev) {
      fresh.apiKey = prev.apiKey
      fresh.otherKey = prev.otherKey
      fresh.appId = prev.appId
      fresh.console = prev.console
      fresh.workspaceId = prev.workspaceId
    }
    fresh.omniPrompt = DEFAULT_OMNI_PROMPT
    openEditor(fresh, true)
  }

  function closeEditor() {
    if (saving) return
    setDraft(null)
    setEngineDraftDirty(false)
  }

  function patchDraft(next: Partial<AsrProfile>) {
    if (!draft) return
    const merged = { ...draft, ...next }
    if (findAsrProvider(merged.provider)?.platform !== 'deepgram') {
      delete merged.deepgramKeytermsEnabled
    }
    setDraft(merged)
    setEngineDraftDirty(JSON.stringify(merged) !== draftBaseline)
  }

  /** Switch provider: clear credentials that don't belong to the new platform, and inherit the new platform's existing key */
  function handleDraftProvider(providerId: string) {
    if (!draft) return
    const nextPlatform = findAsrProvider(providerId)?.platform
    const prevPlatform = findAsrProvider(draft.provider)?.platform
    if (nextPlatform === 'custom' || prevPlatform === 'custom') {
      patchDraft(changeAsrProfileProvider(draft, providerId))
      return
    }
    if (nextPlatform === prevPlatform) {
      patchDraft({ provider: providerId, model: findAsrProvider(providerId)?.model ?? '' })
      return
    }
    // The platform changed and the old key means nothing to the new home — keeping it
    // would mark the profile "configured" while requests keep failing
    const prev = lastProfileOfPlatform(providerId, draft.id)
    const nextProfile = changeAsrProfileProvider(draft, providerId)
    patchDraft({
      ...nextProfile,
      apiKey: prev?.apiKey ?? '',
      otherKey: prev?.otherKey ?? '',
      appId: prev?.appId ?? '',
      console: prev?.console ?? 'new',
      workspaceId: prev?.workspaceId ?? '',
    })
  }

  /** Switch the Doubao console generation: park the current key with this generation and bring in the other generation's key */
  function switchConsole(next: string) {
    if (!draft || (next !== 'new' && next !== 'legacy')) return
    if (next === draft.console) return
    patchDraft({ console: next, apiKey: draft.otherKey, otherKey: draft.apiKey })
  }

  async function handleSaveDraft() {
    if (!draft || saving) return
    setSaving(true)
    try {
      // Invalidate the old verdict when credentials changed: otherwise the "available"
      // badge measured with the old key stays on the card, vouching for a configuration
      // it never tested
      const savedProfile = normalizeAsrProfileForSave(draft)
      const before = profiles.find((p) => p.id === savedProfile.id)
      const configurationChanged = !before || asrProfileCheckShouldInvalidate(before, savedProfile)
      const saved: AsrProfile = { ...savedProfile, check: configurationChanged ? undefined : before?.check }

      const next = draftIsNew
        ? [...profiles, saved]
        : profiles.map((p) => (p.id === saved.id ? saved : p))
      // Newly saved profile becomes active immediately: the user just configured it, so they most likely want to use it
      await persist(next, draftIsNew ? saved.id : activeId)

      setDraft(null)
      setEngineDraftDirty(false)
      const missing = describeAsrMissing(saved)
      setNotice(missing
        ? { tone: 'warning', message: t('asr.msg.savedWithMissing', { missing }) }
        : { tone: 'success', message: t('asr.msg.saved') })
    } catch (err) {
      // The editor stays open with the user's input intact; the error is shown inside
      // the modal because the page-level notice is behind the overlay.
      const friendly = describeProviderError(err)
      setNotice({
        tone: 'error',
        scope: 'editor',
        message: t('asr.msg.saveFailed', { message: friendly.message }),
        detail: friendly.detail,
      })
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    const next = profiles.filter((p) => p.id !== id)
    setPendingDeleteId('')
    setNotice(null)
    try {
      // When the deleted profile was the active one, let resolveActiveAsrProfile fall back to the first entry
      await persist(next, id === activeId ? (next[0]?.id ?? '') : activeId)
    } catch (err) {
      const friendly = describeProviderError(err)
      setNotice({
        tone: 'error',
        message: t('asr.msg.deleteFailed', { message: friendly.message }),
        detail: friendly.detail,
      })
    }
  }

  // ───────────────────────── Cards ─────────────────────────

  interface CardStatus {
    label: string
    tone: 'neutral' | 'ok' | 'warn' | 'bad'
    spoken: string
    hint: string
    /**
     * This card is still missing configuration.
     * A separate flag instead of reusing tone === 'warn': a "slow" latency is also
     * warn, but it asks nothing of the user, so the buttons need not stay visible.
     */
    needsSetup?: boolean
  }

  function describeCard(profile: AsrProfile): CardStatus {
    if (isTesting(profile.id)) {
      return { label: t('asr.status.testing'), tone: 'neutral', spoken: t('asr.status.testingSpoken'), hint: t('asr.status.testingHint') }
    }
    const missing = describeAsrMissing(profile)
    if (missing) {
      return { label: t('asr.status.needsSetup'), tone: 'warn', spoken: missing, hint: missing, needsSetup: true }
    }
    const entry = findAsrProvider(profile.provider)
    if (entry?.needsWorkspaceId && !profile.workspaceId.trim()) {
      return {
        label: t('asr.status.missingWorkspace'),
        tone: 'warn',
        spoken: t('asr.status.missingWorkspaceSpoken'),
        hint: t('asr.status.missingWorkspaceHint'),
        needsSetup: true,
      }
    }
    const check = profile.check
    if (!check) {
      return { label: t('asr.status.untested'), tone: 'neutral', spoken: t('asr.status.untestedSpoken'), hint: t('asr.status.untestedHint') }
    }
    if (!check.ok) {
      const reason = check.reason ?? t('common.unknownReason')
      return {
        label: t('asr.status.unavailable'),
        tone: 'bad',
        spoken: t('asr.status.unavailableSpoken', { reason }),
        hint: t('asr.status.unavailableHint', { when: formatCheckedAt(check.at), reason }),
      }
    }
    const fresh = isCheckFresh(check)
    const ms = check.latencyMs
    if (ms === undefined) {
      return { label: t('asr.status.available'), tone: fresh ? 'ok' : 'neutral', spoken: t('asr.status.available'), hint: t('asr.status.availableHint', { when: formatCheckedAt(check.at) }) }
    }
    const grade = gradeAsrLatency(ms, check.audioSec ?? 0)
    return {
      label: formatLatency(ms),
      // A stale verdict drops back to neutral: green only means "verified just now, trustworthy"
      tone: fresh ? grade.tone : 'neutral',
      spoken: t('asr.status.availableSpoken', { grade: grade.label, latency: formatLatency(ms) }),
      hint: t('asr.status.availableDetailHint', {
        when: formatCheckedAt(check.at),
        sec: (check.audioSec ?? 0).toFixed(1),
        latency: formatLatency(ms),
        grade: grade.label,
        stale: fresh ? '' : t('asr.staleSuffix'),
      }),
    }
  }

  const chipToneClass: Record<CardStatus['tone'], string> = {
    neutral: 'bg-muted text-muted-foreground',
    ok: 'bg-success/10 text-success-strong',
    warn: 'bg-warning/10 text-warning-strong',
    bad: 'bg-destructive/10 text-destructive',
  }

  function renderCard(profile: AsrProfile) {
    const entry = findAsrProvider(profile.provider)
    if (!entry) return null
    const isActive = profile.id === activeId
    const status = describeCard(profile)
    const siblings = profiles.filter((p) => p.provider === profile.provider).length
    const title = profileTitle(profile, siblings)
    const availability = asrAvailabilityLabel(entry)
    const model = entry.customEndpoint ? profile.model || t('asr.customModelPlaceholder') : entry.models ? profile.model : entry.model
    return (
      <ProfileCard
        key={profile.id}
        active={isActive}
        onActivate={() => void handleActivate(profile.id)}
        activateDisabled={activating}
        ariaLabel={t('common.cardStatusAria', { title, subtitle: model, status: status.spoken })}
        title={title}
        subtitle={model}
        statusChip={
          <Tooltip className="pointer-events-auto relative z-10 shrink-0" variant="light" content={status.hint}>
            <span className={cn('cursor-help rounded-full px-2 py-0.5 text-[11px] font-medium', chipToneClass[status.tone])}>
              {status.label}
            </span>
          </Tooltip>
        }
        actionsVisible={status.needsSetup}
        test={{
          ariaLabel: t('asr.testAria', { title }),
          onClick: () => void handleTest(profile),
          disabled: busy,
          spinning: isTesting(profile.id),
        }}
        edit={{
          ariaLabel: t('asr.editAria', { title }),
          onClick: () => openEditor({ ...profile }, false),
          disabled: activating,
        }}
        delete={{
          ariaLabel: t('asr.deleteAria', { title }),
          onClick: () => setPendingDeleteId(profile.id),
          disabled: busy,
        }}
      >
        <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-muted-foreground/80">
          {entry.blurb}
          {/* Most providers have no region note (see asrAvailabilityLabel), so render the
              span only when non-empty to avoid a dangling span and stray whitespace */}
          {availability !== '' && <> <span className="font-medium">{availability}</span></>}
        </p>
      </ProfileCard>
    )
  }

  // ───────────────────── Dialogs ─────────────────────

  function renderEditor() {
    if (!draft) return null
    const platformInfo = ASR_PLATFORMS[draftPlatform]
    const draftEntry = findAsrProvider(draft.provider)
    const draftAvailability = draftEntry ? asrAvailabilityLabel(draftEntry) : ''
    const keyLabel = draftIsDoubao ? doubaoKeyLabel(draft.console) : 'API Key'
    return (
      <Modal
        title={draftIsNew ? t('asr.editorNew') : t('asr.editorEdit')}
        onClose={closeEditor}
        locked={saving}
        showCloseButton
        panelClassName="w-[520px]"
      >
        <div className="mt-4 space-y-3">
          <div>
            <label htmlFor="asr-provider" className="mb-1 block text-sm text-muted-foreground">{t('asr.provider')}</label>
            <Select
              value={draft.provider}
              onChange={(value) => handleDraftProvider(value)}
              options={groupedAsrProviders().map(({ entry, group }) => ({
                value: entry.id,
                label: entry.model ? `${entry.label} · ${entry.model}` : entry.label,
                group,
              }))}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              {draftEntry?.blurb}
              {draftAvailability !== '' && <> <span className="font-medium">{draftAvailability}</span></>}
            </p>
          </div>

          {draftEntry?.customEndpoint && (
            <>
              <div>
                <label htmlFor="asr-base-url" className="mb-1 block text-sm text-muted-foreground">{t('asr.baseUrl')}</label>
                <input
                  id="asr-base-url"
                  value={draft.baseUrl ?? ''}
                  onChange={(e) => patchDraft({ baseUrl: e.target.value })}
                  placeholder={t('asr.baseUrlPlaceholder')}
                  className={inputClass}
                  autoComplete="url"
                  spellCheck={false}
                />
                {/^http:\/\//i.test(draft.baseUrl?.trim() ?? '') && draft.apiKey.trim() !== '' && (
                  <p className="mt-1.5 text-xs text-warning-strong">
                    {/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(draft.baseUrl?.trim() ?? '')
                      ? t('asr.customHttpKeyWarningLocal')
                      : t('asr.customHttpKeyWarningRemote')}
                  </p>
                )}
              </div>
              <div>
                <label htmlFor="asr-custom-model" className="mb-1 block text-sm text-muted-foreground">{t('asr.model')}</label>
                <input
                  id="asr-custom-model"
                  value={draft.model}
                  onChange={(e) => patchDraft({ model: e.target.value })}
                  placeholder={t('asr.modelPlaceholder')}
                  className={inputClass}
                  spellCheck={false}
                />
              </div>
              <div>
                <label id="asr-custom-protocol-label" className="mb-1 block text-sm text-muted-foreground">{t('asr.protocol')}</label>
                <Select
                  value={draft.protocol ?? 'transcriptions'}
                  onChange={(protocol) => patchDraft({ protocol: protocol as AsrProfile['protocol'] })}
                  labelledBy="asr-custom-protocol-label"
                  options={[
                    { value: 'transcriptions', label: t('asr.protocolTranscriptions') },
                    { value: 'chat', label: t('asr.protocolChat') },
                    { value: 'auto', label: t('asr.protocolAuto') },
                  ]}
                />
                {draft.protocol === 'auto' && (
                  <p className="mt-1.5 text-xs text-muted-foreground">{t('asr.protocolAutoHelp')}</p>
                )}
              </div>
            </>
          )}

          {draftEntry?.models && draftEntry.models.length > 1 && (
            <div>
              <label htmlFor="asr-model" className="mb-1 block text-sm text-muted-foreground">{t('asr.model')}</label>
              <Select
                value={draft.model}
                onChange={(model) => patchDraft({ model })}
                options={draftEntry.models.map((model) => ({ value: model, label: model }))}
              />
            </div>
          )}

          {draftPlatform === 'deepgram' && (
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p id="deepgram-keyterms-label" className="text-sm font-medium">{t('asr.deepgramKeyterms')}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t('asr.deepgramKeytermsHelp')}</p>
              </div>
              <Switch
                labelledBy="deepgram-keyterms-label"
                checked={draft.deepgramKeytermsEnabled === true}
                onChange={() => patchDraft({ deepgramKeytermsEnabled: draft.deepgramKeytermsEnabled !== true })}
              />
            </div>
          )}

          {draftIsDoubao && (
            <div>
              <label className="mb-1.5 block text-sm text-muted-foreground">{t('asr.consoleVersion')}</label>
              <Segmented
                label={t('asr.consoleVersionLabel')}
                size="sm"
                value={draft.console}
                // The constant table stores keys; they are translated to the current language here
                options={DOUBAO_CONSOLE_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
                onChange={switchConsole}
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                {draft.console === 'new'
                  ? t('asr.consoleNewHint')
                  : t('asr.consoleLegacyHint')}
              </p>
            </div>
          )}

          {draftIsDoubao && draft.console === 'legacy' && (
            <div>
              <label htmlFor="asr-app-id" className="mb-1 block text-sm text-muted-foreground">App ID</label>
              <input
                id="asr-app-id"
                value={draft.appId}
                onChange={(e) => patchDraft({ appId: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleSaveDraft() }}
                placeholder={t('asr.appIdPlaceholder')}
                className={inputClass}
              />
              {draft.appId.trim() && !/^\d+$/.test(draft.appId.trim()) && (
                <FormatHint text={t('asr.hint.appId')} />
              )}
            </div>
          )}

          {/* data-modal-autofocus: on open, focus lands on the key field (the thing the
              user came to do) instead of the first focusable element */}
          <div data-modal-autofocus>
            <label htmlFor="asr-api-key" className="mb-1 block text-sm text-muted-foreground">
              {draftEntry?.customEndpoint ? t('asr.customApiKeyOptional') : keyLabel}
            </label>
            <PasswordInput
              id="asr-api-key"
              label={draftEntry?.customEndpoint ? t('asr.customApiKeyOptional') : keyLabel}
              value={draft.apiKey}
              onChange={(v) => patchDraft({ apiKey: v })}
              onSubmit={() => void handleSaveDraft()}
              placeholder={t('asr.keyPlaceholder', { platform: platformInfo.label, keyLabel })}
              className={inputClass}
            />
            {/\s/.test(draft.apiKey) && (
              <FormatHint text={t('asr.hint.key')} />
            )}
            {draftPlatform === 'qwen' && draft.apiKey.trim() && !/^sk-/.test(draft.apiKey.trim()) && (
              <FormatHint text={t('asr.hint.bailianKey')} />
            )}
            {/* The key did not appear out of thin air: say where it came from so the user doesn't think they misread */}
            {draftKeyInherited && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t('asr.keyReused')}
              </p>
            )}
            {platformInfo.consoleUrl !== '' && (
              <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
                <button type="button" onClick={() => void shellOpen(platformInfo.consoleUrl)} className={linkClass}>
                  {t('asr.openConsole', { platform: platformInfo.label })}
                  <ExternalLink className="h-3 w-3" aria-hidden />
                </button>
              </div>
            )}
          </div>

          {draftEntry?.needsWorkspaceId && (
            <div>
              <label htmlFor="qwen-workspace-id" className="mb-1 block text-sm text-muted-foreground">
                {t('asr.workspaceId')}
              </label>
              <PasswordInput
                id="qwen-workspace-id"
                label={t('asr.workspaceId')}
                value={draft.workspaceId}
                onChange={(v) => patchDraft({ workspaceId: v })}
                placeholder={t('asr.workspacePlaceholder')}
                className={inputClass}
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                {t('asr.workspaceHint')}
              </p>
            </div>
          )}

          {/* Omni models combine "recognition + cleanup"; the System Prompt decides how
              the cleanup looks. That is behavior of this service configuration, so it
              lives on this profile */}
          {draftEntry?.omni && (
            <div>
              <label htmlFor="omni-system-prompt" className="mb-1.5 block text-sm text-muted-foreground">
                System Prompt
              </label>
              <Segmented
                className="mb-1.5"
                label={t('asr.systemPromptPreset')}
                size="sm"
                value={draft.omniPrompt}
                options={OMNI_PROMPT_PRESETS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
                onChange={(v) => patchDraft({ omniPrompt: v })}
              />
              <textarea
                id="omni-system-prompt"
                value={draft.omniPrompt}
                onChange={(e) => patchDraft({ omniPrompt: e.target.value })}
                placeholder={DEFAULT_OMNI_PROMPT}
                rows={2}
                className="w-full resize-y rounded-md border border-input-border bg-input-bg px-3 py-2 text-sm transition-colors focus:border-input-focus-border"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                {t('asr.omniNote')}
              </p>
            </div>
          )}

          {notice?.scope === 'editor' && (
            <Feedback tone={notice.tone} message={notice.message} detail={notice.detail} />
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={closeEditor} disabled={saving}>{t('common.cancel')}</Button>
            <Button size="sm" onClick={() => void handleSaveDraft()} disabled={saving || !draftDirty}>
              {saving ? t('common.saving') : t('common.save')}
            </Button>
          </div>
        </div>
      </Modal>
    )
  }

  const pendingDelete = profiles.find((p) => p.id === pendingDeleteId) ?? null

  return (
    <Card>
      <CardContent className="p-6">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 grow basis-[18rem]">
            <div className="flex items-center gap-2">
              <h2 id="asr-service-heading" className="text-lg font-semibold">{t('asr.title')}</h2>
              <Tooltip
                variant="light"
                content={t('asr.help')}
              >
                <Info aria-label={t('asr.helpAria')} className={helpIconClass} />
              </Tooltip>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('asr.desc')}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* Runs concurrently, so there is no "Stop": an invoke request cannot be
                withdrawn, and a button that stops nothing is worse than none. The batch
                only waits for the slowest card anyway. */}
            <Button
              variant="outline"
              size="sm"
              className="h-8 shrink-0"
              onClick={() => void handleTestAll()}
              disabled={busy || profiles.length === 0}
            >
              <RefreshCw className={cn('mr-1 h-3.5 w-3.5', batch && 'animate-spin')} aria-hidden />
              {batch ? t('asr.testingBatch', { done: batch.done, total: batch.total }) : t('asr.testAll')}
            </Button>
            <Button variant="outline" size="sm" className="h-8 shrink-0" onClick={handleNew} disabled={busy}>
              <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
              {t('common.new')}
            </Button>
          </div>
        </div>

        {!loaded ? (
          <p className="py-2 text-sm text-muted-foreground">{t('asr.loading')}</p>
        ) : profiles.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-4 text-center text-sm text-muted-foreground">
            {t('asr.empty')}
          </p>
        ) : (
          <div
            role="radiogroup"
            aria-labelledby="asr-service-heading"
            className="grid gap-2.5 sm:grid-cols-3"
          >
            {profiles.map(renderCard)}
          </div>
        )}

        {notice && notice.scope !== 'editor' && (
          <Feedback className="mt-3" tone={notice.tone} message={notice.message} detail={notice.detail} />
        )}
        {activeProvider && supportedLanguages && speechLanguage !== 'auto' && !supportedLanguages.includes(speechLanguage) && (
          <p className="mt-3 text-xs text-muted-foreground">
            {t('asr.lang.supportedOnly', { langs: supportedLanguages.map((lang) => t(`local.lang.${lang}` as 'local.lang.en')).join(t('common.listSeparator')) })}
          </p>
        )}
        {activeProvider && !supportedLanguages && (
          <p className="mt-3 text-xs text-muted-foreground">
            {t(sendsLanguageHint ? 'asr.lang.hintSent' : 'asr.lang.autoOnly')}
          </p>
        )}
      </CardContent>

      {renderEditor()}

      {pendingDelete && (
        <ConfirmDeleteModal
          title={t('asr.deleteTitle')}
          showCloseButton
          body={t('asr.deleteBody', { name: profileTitle(pendingDelete, profiles.filter((p) => p.provider === pendingDelete.provider).length) })}
          onCancel={() => setPendingDeleteId('')}
          onConfirm={() => void handleDelete(pendingDelete.id)}
        />
      )}
    </Card>
  )
}
