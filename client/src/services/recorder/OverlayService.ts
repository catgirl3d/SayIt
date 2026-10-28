import { getLocale, t, type TranslationKey } from '@/i18n'
import * as bridge from '../bridge'
import { addRuntimeEvent } from '../debugLog'
import { getSetting } from '../store'
import { clampSec } from '../timeModel'
import type { AiFailureReason } from '../transcription/types'
import {
  formatRecordingLimit,
  OVERLAY_WIDTH_PRESETS,
  type OverlayCommonPayload,
  type FailureOverlayPayload,
  type FailureRecovery,
  type OverlayWaveTheme,
  type OverlayWidthPreset,
  type SubtitleOverlayPayload,
} from './types'
import type { MicSourceMode } from './micSourceReminder'

type OverlayVisualState = 'waiting' | 'listening' | 'thinking' | 'fallback' | 'failure' | 'error' | 'toast'

interface MicSourceHint {
  mode: MicSourceMode
  label: string
}

const MIC_SOURCE_HINT_DURATION_MS = 3000

/**
 * How long a context woken by `prepareReadySound()` may stay running while no tone is requested.
 *
 * A recording attempt that is cancelled before the microphone is up (a short press) never plays
 * the tone, so nothing else would suspend the context again. Capture normally starts well within
 * this window, which is why the timer only covers the abandoned attempts.
 */
const READY_SOUND_IDLE_SUSPEND_MS = 5000

/**
 * Window width assigned to toast and single-line error notices.
 *
 * Recording waveforms take a fixed width according to `OverlayWidthPreset` (200-360px),
 * but toasts carry localized diagnostic messages (e.g. AI cleanup failure reasons) that
 * need up to ~550px. The native overlay clamps `baseWidth` at 600px without layout changes.
 * The transparent overlay window centers the pill horizontally, and the pill itself hugs
 * its content (`fit-content`), so shorter toasts remain compact.
 */
export const OVERLAY_TOAST_WINDOW_WIDTH = 600

const AI_CLEANUP_FAILURE_TOAST_KEYS: Record<AiFailureReason, TranslationKey> = {
  timeout: 'overlay.toastAiCleanupTimeout',
  provider_error: 'overlay.toastAiCleanupError',
  empty_result: 'overlay.toastAiCleanupEmpty',
  incomplete_profile: 'overlay.toastAiCleanupProfile',
}

function normalizeTheme(value: unknown): OverlayWaveTheme {
  if (value === 'black-white' || value === 'black-blue' || value === 'black-rainbow') {
    return value
  }
  return 'black-blue'
}

function normalizeWidthPreset(value: unknown): OverlayWidthPreset {
  if (value === 'short' || value === 'medium' || value === 'long') return value
  return 'long'
}

export class OverlayService {
  private theme: OverlayWaveTheme = 'black-rainbow'
  private showDuration = true
  private readySoundEnabled = true
  private widthPreset: OverlayWidthPreset = 'medium'
  private lastFrameAt = 0
  /** Arrival time of the latest PCM frame, which can be newer than `lastFrameAt` when the throttle drops it. */
  private lastPcmAt = 0
  private tickerId: ReturnType<typeof setInterval> | null = null
  private fallbackHideId: ReturnType<typeof setTimeout> | null = null
  /** Persistent warning text — included in every overlay update until cleared */
  private activeWarning = ''
  private timeoutWarningHideId: ReturnType<typeof setTimeout> | null = null
  /** Streaming live-recognition text — updated with intermediate results during recording and merged into every listening update. */
  private streamingText = ''
  /** Whether streaming live display is on for this recording: when true the bubble is shown from the very start (placeholder) and the window is never resized mid-recording. */
  private streamingActive = false
  private currentState: OverlayVisualState = 'waiting'
  private activeMicSourceHint: MicSourceHint | null = null
  private micSourceHintHideId: ReturnType<typeof setTimeout> | null = null
  private micSourceHintGeneration = 0
  private overlayGeneration = 0
  private activeCardToken = 0
  private failurePayload: (FailureOverlayPayload & { warning?: string }) | null = null

  constructor(private readonly getElapsedSec: () => number) { }

  async refreshSettings() {
    this.theme = normalizeTheme(await getSetting('overlayWaveTheme', 'black-rainbow'))
    this.showDuration = Boolean(await getSetting('overlayShowDuration', true))
    this.readySoundEnabled = Boolean(await getSetting('readySoundEnabled', true))
    this.widthPreset = normalizeWidthPreset(await getSetting('overlayWidth', 'medium'))
  }

  /**
   * The ready-tone context is kept between recordings, but only suspended: a running idle
   * context keeps rendering its audio graph (measured in Chromium 141: about 18.6 ms of CPU
   * per second against 8.5 ms suspended and 7.5 ms with no context at all, roughly 1% of a core
   * for as long as the app runs). Waking it takes a median of about 35 ms (rarely a few hundred),
   * and a brand-new context costs the same, so it is woken early, when the recording attempt
   * begins (`prepareReadySound`), and the tone is not delayed by it: capture start takes hundreds
   * of milliseconds anyway.
   */
  private readySoundCtx: AudioContext | null = null
  /**
   * Tail of the chain that serializes every wake, tone and suspend of the context.
   *
   * resume() and suspend() are asynchronous and `state` only changes once they settle, so a
   * tone requested while a suspend is in flight would still see `running` and schedule its
   * oscillator on a context that is about to freeze. Running the transitions one after another
   * also lets a tone reuse the wake-up that `prepareReadySound` already started instead of
   * calling resume() a second time.
   */
  private readySoundChain: Promise<void> = Promise.resolve()
  /** Tones requested or still sounding; the context is suspended only after the last one ends. */
  private readySoundPending = 0
  private readySoundIdleId: ReturnType<typeof setTimeout> | null = null

  /**
   * Wake the ready-tone context at the start of a recording attempt, so that it is already
   * running when `playReadySound` fires once capture is up. Does nothing when the sound is off.
   */
  prepareReadySound() {
    if (!this.readySoundEnabled) return
    const ctx = this.ensureReadySoundCtx()
    if (!ctx) return
    this.clearReadySoundIdleTimer()
    this.readySoundIdleId = setTimeout(() => {
      this.readySoundIdleId = null
      this.enqueueReadySoundStep(() => this.suspendReadySoundCtx(ctx))
    }, READY_SOUND_IDLE_SUSPEND_MS)
    this.enqueueReadySoundStep(() => this.wakeReadySoundCtx(ctx))
  }

  private playReadySound() {
    if (!this.readySoundEnabled) return
    const ctx = this.ensureReadySoundCtx()
    if (!ctx) return
    // A tone is on its way: the context must stay awake until it has ended.
    this.clearReadySoundIdleTimer()
    this.readySoundPending++
    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      this.settleReadyTone(ctx)
    }
    this.enqueueReadySoundStep(async () => {
      try {
        await this.wakeReadySoundCtx(ctx)
        this.emitReadyTone(ctx, settle)
      } catch {
        // The chime is cosmetic and must never disturb recording. Release the tone so the
        // pending count cannot leak and keep the context awake for good.
        settle()
      }
    })
  }

  /** Reuse the context unless it is missing or closed; null when the WebView cannot create one. */
  private ensureReadySoundCtx(): AudioContext | null {
    if (this.readySoundCtx && this.readySoundCtx.state !== 'closed') return this.readySoundCtx
    try {
      this.readySoundCtx = new AudioContext()
    } catch {
      // No AudioContext (jsdom, unsupported WebView): the recorder works fine without the chime.
      this.readySoundCtx = null
    }
    return this.readySoundCtx
  }

  /**
   * Run one context transition after all earlier ones have settled. A failed step is swallowed
   * so that it can never block the next one: each step reads the context's actual state again.
   */
  private enqueueReadySoundStep(step: () => Promise<void>) {
    this.readySoundChain = this.readySoundChain.then(step).catch(() => { /* ignore */ })
  }

  private async wakeReadySoundCtx(ctx: AudioContext) {
    // A fresh AudioContext (browser autoplay/save-power policies), or one suspended after the
    // previous tone, is in the suspended state. resume() is asynchronous: calling start()
    // without waiting for it can silently drop or delay the oscillator — this is the root
    // cause of "no ready tone on the first hands-free press, and none on a later one either".
    if (ctx.state === 'suspended') await ctx.resume()
  }

  private async suspendReadySoundCtx(ctx: AudioContext) {
    if (ctx.state === 'running') await ctx.suspend()
  }

  private settleReadyTone(ctx: AudioContext) {
    if (--this.readySoundPending > 0) return
    this.enqueueReadySoundStep(() => this.suspendReadySoundCtx(ctx))
  }

  private clearReadySoundIdleTimer() {
    if (this.readySoundIdleId) {
      clearTimeout(this.readySoundIdleId)
      this.readySoundIdleId = null
    }
  }

  private emitReadyTone(ctx: AudioContext, onEnded: () => void) {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.frequency.value = 880
    osc.type = 'sine'
    gain.gain.setValueAtTime(0.2, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15)
    osc.onended = onEnded
    osc.start(ctx.currentTime)
    osc.stop(ctx.currentTime + 0.15)
  }

  getCommonPayload(): OverlayCommonPayload {
    const cfg = OVERLAY_WIDTH_PRESETS[this.widthPreset]
    return {
      theme: this.theme,
      showDuration: this.showDuration,
      baseWidth: cfg.windowWidth,
      barCount: cfg.barCount,
      // Sent on every call: the overlay window may be created for the first time after a
      // locale switch, so there is no "send once" moment.
      locale: getLocale(),
    }
  }

  getBarCount(): number {
    return OVERLAY_WIDTH_PRESETS[this.widthPreset].barCount
  }

  showSubtitles(payload: SubtitleOverlayPayload): Promise<number> {
    return bridge.presentOverlay({ state: 'subtitles', ...payload, locale: getLocale() })
  }

  updateSubtitles(payload: SubtitleOverlayPayload): Promise<void> {
    return bridge.updateOverlay({ state: 'subtitles', ...payload, locale: getLocale() })
  }

  hideSubtitles(): Promise<void> {
    return bridge.hideOverlay()
  }

  private setEscapeMode(mode: bridge.EscapeActionMode, token = 0) {
    void bridge.setEscapeActionMode(mode, token).catch(() => { /* A missing native hook does not affect the overlay */ })
  }

  private getMicSourceHintPayload() {
    return this.activeMicSourceHint
      ? {
        micSourceMode: this.activeMicSourceHint.mode,
        micSourceLabel: this.activeMicSourceHint.label,
      }
      : {
        micSourceMode: null,
        micSourceLabel: '',
      }
  }

  private clearMicSourceHint() {
    this.micSourceHintGeneration++
    if (this.micSourceHintHideId) {
      clearTimeout(this.micSourceHintHideId)
      this.micSourceHintHideId = null
    }
    this.activeMicSourceHint = null
  }

  private beginPresentation(state: OverlayVisualState) {
    this.overlayGeneration++
    this.currentState = state
    this.activeCardToken = 0
    this.failurePayload = null
    this.clearFallbackHideTimer()
    this.clearMicSourceHint()
    return this.overlayGeneration
  }

  /** Briefly confirm the actual input route after a successful microphone open. */
  showMicSourceHint(hint: MicSourceHint) {
    this.clearMicSourceHint()
    this.activeMicSourceHint = hint
    const generation = this.micSourceHintGeneration

    this.publishLiveListening({}, this.currentState)

    this.micSourceHintHideId = setTimeout(() => {
      if (generation !== this.micSourceHintGeneration) return
      this.micSourceHintHideId = null
      this.activeMicSourceHint = null
      this.publishLiveListening({}, this.currentState)
    }, MIC_SOURCE_HINT_DURATION_MS)
  }

  /** Text is about to enter the irreversible system-paste stage; turn off the global Esc cancel first so a "canceled" notice cannot be followed by a completed paste. */
  async disableEscapeAction(): Promise<void> {
    try {
      await bridge.setEscapeActionMode('off', 0)
    } catch { /* A missing native hook does not affect text insertion */ }
  }

  showWaiting() {
    // A recording attempt begins: wake the ready-tone context now so the tone is not delayed.
    this.prepareReadySound()
    this.beginPresentation('waiting')
    this.setEscapeMode('off', 0)
    this.clearFallbackHideTimer()
    void bridge.presentOverlay({
      state: 'waiting',
      elapsedSec: 0,
      ...this.getMicSourceHintPayload(),
      ...this.getCommonPayload(),
    })
  }

  startListeningTicker(token = 0) {
    this.currentState = 'listening'
    this.stopListeningTicker()
    // Only a real recording run enables the global Esc; token=0 previews such as PTT Lab must never swallow system keys.
    this.setEscapeMode(token > 0 ? 'cancel_recording' : 'off', token)
    this.playReadySound()
    // Publish listening immediately once capture has started successfully; do not keep
    // waiting artificially for the ticker's first 33 ms. PCM still drives the real
    // waveform through pushListeningBars afterwards.
    this.pushListeningBars(undefined, true)
    // While PCM frames keep arriving, pushListeningBars already publishes every 33 ms with the
    // waveform, timer, streaming text and warnings attached, so the ticker yields. It fills in
    // only after 33 ms without frames (stalled capture, no first frame yet, PTT Lab). The two
    // sources used to run independently, giving ~60 updates per second for a 30 fps picture.
    // The yield decision uses frame arrival time, not the last publish: a fixed-phase ticker
    // that yielded on the last publish alone would win every slot and starve the bars.
    this.tickerId = setInterval(() => {
      if (Date.now() - this.lastPcmAt < 33) return
      this.publishLiveListening()
    }, 33)
  }

  /** Set whether streaming live display is on for this recording (called at recording start). When on, the bubble shows a placeholder from the very beginning. */
  setStreamingActive(on: boolean) {
    this.streamingActive = on
  }

  /** Update the streaming live-recognition text. The next listening heartbeat (33 ms) carries
   *  it to the overlay for rendering. An empty string clears the bubble. */
  setStreamingText(text: string) {
    this.streamingText = text || ''
  }

  /** Clear the streaming text and the active flag (called on recording stop/reset). */
  resetStreamingText() {
    this.streamingText = ''
    this.streamingActive = false
  }

  stopListeningTicker() {
    if (this.tickerId) {
      clearInterval(this.tickerId)
      this.tickerId = null
    }
  }

  pushListeningBars(bars?: number[], force = false) {
    const now = Date.now()
    if (bars) this.lastPcmAt = now
    if (!force && now - this.lastFrameAt < 33) return
    this.lastFrameAt = now
    this.publishLiveListening({ bars })
  }

  /** Publish one incremental listening update with the current warnings, streaming text
   *  and mic-source hint attached. `extra` carries per-call fields such as PCM `bars`. */
  private publishLiveListening(extra: Record<string, unknown> = {}, state: OverlayVisualState = 'listening') {
    void bridge.updateOverlay({
      state,
      ...extra,
      elapsedSec: clampSec(this.getElapsedSec()),
      ...(this.activeWarning ? { warning: this.activeWarning } : {}),
      ...(this.streamingActive ? { streaming: true } : {}),
      ...(this.streamingText ? { streamingText: this.streamingText } : {}),
      ...this.getMicSourceHintPayload(),
      ...this.getCommonPayload(),
    })
  }

  /** Publish a transient listening warning line (text plus its tone) without touching
   *  the persistent warning state. */
  private publishListeningWarning(text: string, tone: 'warn' | 'error') {
    void bridge.updateOverlay({
      state: 'listening',
      warning: text,
      warningTone: tone,
      elapsedSec: clampSec(this.getElapsedSec()),
      ...this.getMicSourceHintPayload(),
      ...this.getCommonPayload(),
    })
  }

  showThinking(elapsedSec: number, token = 0) {
    this.currentState = 'thinking'
    // PTT Lab reuses the thinking animation but has no real recording run; token=0 only displays and never swallows the global Esc.
    this.setEscapeMode(token > 0 ? 'cancel_processing' : 'off', token)
    void bridge.updateOverlay({
      state: 'thinking',
      elapsedSec: clampSec(elapsedSec),
      ...this.getMicSourceHintPayload(),
      ...this.getCommonPayload(),
    })
  }

  /**
   * Notice that the single-recording limit is coming up. **It flashes once and goes away**;
   * afterwards the countdown in the timer area keeps telling how much time is left.
   *
   * This line used to stay visible until the end of the recording, and combined with the
   * Overlay rule "a warning hides the timer" it left the final minute showing only
   * "single recording max 300 s" — neither how long the user had been recording nor how
   * much time remained.
   */
  showTimeoutWarning() {
    const text = t('overlay.warnMaxDuration', { limit: formatRecordingLimit() })
    this.activeWarning = text
    this.publishListeningWarning(text, 'warn')

    if (this.timeoutWarningHideId) clearTimeout(this.timeoutWarningHideId)
    this.timeoutWarningHideId = setTimeout(() => {
      this.timeoutWarningHideId = null
      // If a higher-priority warning (e.g. muted microphone) replaced it meanwhile, do not reclaim it.
      if (this.activeWarning !== text) return
      this.activeWarning = ''
      this.publishListeningWarning('', 'warn')
    }, 4000)
  }

  /** Show the low-volume warning on the overlay (sound present but quiet: "move closer to the mic", amber). */
  showLowVolumeWarning() {
    if (this.activeWarning) return
    this.publishListeningWarning(t('overlay.warnLowVolume'), 'warn')
  }

  /** Show the "no signal detected" warning (a persistent lack of input means the device is unusable; red high-alert). */
  showNoSignalWarning() {
    if (this.activeWarning) return
    this.publishListeningWarning(t('overlay.warnNoSignal'), 'error')
  }

  /** Show the "mic is muted" high-alert (confirmed mute at the system level: red high-alert). */
  showMicMutedAlert() {
    if (this.activeWarning) return
    this.publishListeningWarning(t('overlay.warnMicMuted'), 'error')
  }

  /** Clear transient warnings (low volume etc.) — does NOT clear timeout warning */
  clearWarning() {
    if (this.activeWarning) return
    this.publishListeningWarning('', 'warn')
  }

  /**
   * Whether a persistent (sticky) warning is currently blocking transient warnings
   * from showing or clearing. Useful when investigating "the low-volume hint never
   * disappears / never appears" symptoms: they are usually being blocked by it.
   */
  hasStickyWarning() {
    return !!this.activeWarning
  }

  /** Reset all warnings including persistent ones (called on recording stop/reset) */
  resetWarnings() {
    if (this.timeoutWarningHideId) {
      clearTimeout(this.timeoutWarningHideId)
      this.timeoutWarningHideId = null
    }
    this.activeWarning = ''
  }

  showFallback(text: string, reason: string, token = 0, warning?: string) {
    const generation = this.beginPresentation('fallback')
    this.activeCardToken = token
    console.log('[OverlayService] showFallback called, text:', text.slice(0, 30), 'reason:', reason)
    // A PTT Lab card has no Orchestrator generation when token is zero, so it must not enable a global Esc action with no consumer.
    this.setEscapeMode(token > 0 ? 'dismiss_fallback' : 'off', token)
    void bridge.presentOverlay({
      state: 'fallback',
      fallbackText: text,
      fallbackReason: reason,
      cardToken: token,
      warning: warning ?? '',
      ...this.getCommonPayload(),
    })
    this.fallbackHideId = setTimeout(() => {
      if (generation !== this.overlayGeneration || this.currentState !== 'fallback') return
      console.log('[OverlayService] fallback auto-hide timer fired')
      this.hide()
    }, 10000)
  }

  showFailure(payload: Omit<FailureOverlayPayload, 'state'> & { warning?: string }) {
    const generation = this.beginPresentation('failure')
    this.activeCardToken = payload.cardToken
    this.failurePayload = { state: 'failure', ...payload, warning: payload.warning ?? '' }
    this.setEscapeMode(payload.cardToken > 0 ? 'dismiss_fallback' : 'off', payload.cardToken)
    void bridge.presentOverlay({
      ...this.failurePayload,
      ...this.getCommonPayload(),
    })
    this.fallbackHideId = setTimeout(() => {
      if (generation !== this.overlayGeneration || this.activeCardToken !== payload.cardToken) return
      this.hide()
    }, 5000)
  }

  updateFailureRecovery(recovery: FailureRecovery, token: number) {
    if (
      this.currentState !== 'failure'
      || this.activeCardToken !== token
      || !this.failurePayload
    ) return

    this.failurePayload = { ...this.failurePayload, failureRecovery: recovery }
    void bridge.updateOverlay({
      ...this.failurePayload,
      ...this.getCommonPayload(),
    })
  }

  dismissCard(token: number) {
    if (token === 0 || this.activeCardToken !== token) return
    this.hide()
  }

  clearFallbackHideTimer() {
    if (this.fallbackHideId) {
      clearTimeout(this.fallbackHideId)
      this.fallbackHideId = null
    }
  }

  hide() {
    this.overlayGeneration++
    this.currentState = 'waiting'
    this.activeCardToken = 0
    this.failurePayload = null
    this.clearMicSourceHint()
    this.clearFallbackHideTimer()
    this.setEscapeMode('off', 0)
    return bridge.hideOverlay()
  }

  /** Present a short-lived toast card and auto-hide it after `durationMs`.
   *  Only the presentation that scheduled the timer may hide the overlay. */
  private showToast(text: string, tone: 'info' | 'warn', durationMs: number) {
    const generation = this.beginPresentation('toast')
    this.setEscapeMode('off', 0)
    void bridge.presentOverlay({
      state: 'toast',
      toastText: text,
      toastTone: tone,
      ...this.getCommonPayload(),
      baseWidth: OVERLAY_TOAST_WINDOW_WIDTH,
    })
    this.fallbackHideId = setTimeout(() => {
      if (generation === this.overlayGeneration) this.hide()
    }, durationMs)
  }

  /** Briefly show the current text-polishing mode after its shortcut is pressed, then hide the overlay after about 1.6 seconds. */
  showPresetSwitched(name: string) {
    this.showToast(t('overlay.toastPresetSwitched', { name }), 'info', 1600)
  }

  /** Lightweight confirmation for the global AI-cleanup shortcut; it does not interrupt active recording. */
  showAiCleanupToggled(enabled: boolean) {
    this.showToast(t(enabled ? 'overlay.toastAiCleanupOn' : 'overlay.toastAiCleanupOff'), 'info', 1400)
  }

  /**
   * Explain a failed AI cleanup once the recognized text has actually been inserted.
   *
   * The toast carries the reason (no response, provider error, empty response, incomplete
   * profile) because the inserted fallback text alone cannot tell the user whether the AI
   * stage ran at all. `warningLabel` is a short, already translated second fact for the
   * same single-line toast (e.g. the dictionary was dropped).
   */
  showAiCleanupFailed(reason: AiFailureReason, warningLabel?: string) {
    addRuntimeEvent('warn', 'recorder', 'Showing AI cleanup failure toast', { reason })
    const baseLabel = t(AI_CLEANUP_FAILURE_TOAST_KEYS[reason])
    this.showToast(warningLabel ? `${baseLabel} · ${warningLabel}` : baseLabel, 'warn', 4000)
  }

  /**
   * Show the empty-recognition (no valid sound detected) notice.
   *
   * The caller supplies cause context through `diagnostic`. Logging intentionally lives here
   * rather than at each call site because this is one of the easiest notices in the application
   * to misinterpret: the actual cause may be silence, exhausted provider quota, an early server
   * disconnect, or failed text post-processing, while the user sees the same notice. Keeping the
   * log at this single exit point ensures every display of the notice has a corresponding log
   * entry, including if another call site is added later.
   *
   * `warningLabel` is a short, already translated second fact for the same toast (e.g. the
   * dictionary was dropped); the toast is single-line, so both facts must stay short.
   */
  showNoSpeech(diagnostic?: Record<string, unknown>, warningLabel?: string) {
    addRuntimeEvent('warn', 'recorder', 'Showing no-speech warning', diagnostic ?? {})
    const baseLabel = t('overlay.toastNoSpeech')
    this.showToast(warningLabel ? `${baseLabel} · ${warningLabel}` : baseLabel, 'warn', 1500)
  }

  /** Keep the native 56px toast short; recovery cards and History carry the full notice. */
  showAsrWarning() {
    this.showToast(t('asr.deepgramKeytermLimitToast'), 'warn', 5000)
  }

  /** Brief confirmation after the user cancels processing. */
  showCanceled() {
    this.showToast(t('overlay.toastCanceled'), 'info', 900)
  }

  /** Show an error message and hide it after a few seconds. */
  showError(message: string) {
    const generation = this.beginPresentation('error')
    this.setEscapeMode('off', 0)
    void bridge.presentOverlay({
      state: 'error',
      errorMessage: message,
      ...this.getCommonPayload(),
      baseWidth: OVERLAY_TOAST_WINDOW_WIDTH,
    })
    this.fallbackHideId = setTimeout(() => {
      if (generation === this.overlayGeneration) this.hide()
    }, 4000)
  }

  dispose() {
    this.stopListeningTicker()
    this.resetStreamingText()
    this.hide()
  }
}
