import * as bridge from '../services/bridge'
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Copy, MicVocal, Sparkles, X } from 'lucide-react'
import { SuccessCheck } from '@/components/ui/success-check'
import { isLocale, setLocale } from '@/i18n'
import { useT } from '@/i18n/useT'
import { addRuntimeEvent } from '../services/debugLog'
import { formatRecordingTimer } from '../services/recorder/types'
import type { FailureOverlayPayload, OverlayCommonPayload, SubtitleOverlayPayload } from '../services/recorder/types'
import {
  buildWavePalette,
  DEFAULT_CUSTOM_WAVE,
  DEFAULT_WAVE_THEME,
  getWaveThinkingColor,
  getWaveTimerColor,
  normalizeCustomWave,
  normalizeWaveTheme,
  sameCustomWave,
  type CustomWaveColors,
  type OverlayWaveTheme,
} from '@/lib/overlayWaveColors'
import { motionAllowed, setMotionEnabled, useMotionAllowed } from '@/lib/motion'
import { usePillMorph } from './pillMorph'

type OverlayState = 'waiting' | 'listening' | 'thinking' | 'fallback' | 'failure' | 'error' | 'toast' | 'subtitles'
type RecordingVisualPhase = 'preparing' | 'listening'
type OverlayPayload =
  /** UI language, sent by the main window with every update (see OverlayCommonPayload.locale). */
  Partial<OverlayCommonPayload> &
    Partial<Omit<FailureOverlayPayload, 'state'>> &
    Partial<SubtitleOverlayPayload> & {
      state?: OverlayState
      bars?: number[]
      elapsedSec?: number
      /** True when this run's start-frozen AI setup is eligible (AI on and at/above the start-time minimum), not the live toggle. */
      thinkingAi?: boolean
      fallbackText?: string
      fallbackReason?: string
      errorMessage?: string
      warning?: string
      /** Warning severity: warn = amber (quiet or no sound detected), error = red alert (microphone muted). */
      warningTone?: 'warn' | 'error'
      toastText?: string
      /** Toast tone: info = neutral (e.g. a preset was switched), warn = amber with an icon (e.g. no sound detected). */
      toastTone?: 'info' | 'warn'
      streaming?: boolean
      streamingText?: string
      micSourceMode?: 'auto' | 'fixed' | null
      micSourceLabel?: string
      _overlayShowId?: number
      _overlayGeneration?: number
      _overlayProbe?: boolean
    }

const DEFAULT_BAR_COUNT = 24
const MIN_PREPARING_VISUAL_MS = 160
const IDLE_BARS = Array(DEFAULT_BAR_COUNT).fill(3)
const SUBTITLE_STATUS_CLASS = 'mb-2 text-[11px] font-medium tracking-wide'
const LIVE_STATUS_CLASS = 'max-h-[48px] overflow-hidden break-words text-[11px] font-medium leading-4 tracking-wide line-clamp-3 [@media(max-height:299px)_and_(min-height:255px)]:max-h-[32px] [@media(max-height:299px)_and_(min-height:255px)]:line-clamp-2 [@media(max-height:254px)]:max-h-[12px] [@media(max-height:254px)]:leading-3 [@media(max-height:254px)]:line-clamp-1'
const LIVE_STATUS_ERROR_CLASS = ' [@media(max-height:360px)_and_(min-height:261px)]:max-h-[32px] [@media(max-height:360px)_and_(min-height:261px)]:line-clamp-2'
const SUBTITLE_ERROR_CLASS = 'text-base leading-6 text-amber-300'
const LIVE_SUBTITLE_ERROR_CLASS = 'max-h-[72px] overflow-hidden break-words text-base leading-6 text-amber-300 line-clamp-3 [@media(max-height:260px)]:max-h-[40px] [@media(max-height:260px)]:leading-5 [@media(max-height:260px)]:line-clamp-2'
const SOURCE_CAPTION_BASE_CLASS = 'mb-1.5 whitespace-pre-wrap break-words text-sm leading-5'
const LIVE_SOURCE_CAPTION_CLASS = ' max-h-[60px] overflow-hidden line-clamp-3 [@media(max-height:399px)]:mb-1 [@media(max-height:399px)]:max-h-[16px] [@media(max-height:399px)]:leading-4 [@media(max-height:399px)]:line-clamp-1'
const LIVE_SOURCE_CAPTION_COMPACT_CLASS = ' max-h-[40px] overflow-hidden line-clamp-2 [@media(max-height:399px)]:mb-1 [@media(max-height:399px)]:max-h-[16px] [@media(max-height:399px)]:leading-4 [@media(max-height:399px)]:line-clamp-1'
const BATCH_SOURCE_CAPTION_CLASS = ' line-clamp-3'
const TRANSLATION_CAPTION_BASE_CLASS = 'whitespace-pre-wrap break-words text-xl font-medium leading-8'
const LIVE_TRANSLATION_CAPTION_CLASS = ' max-h-[96px] overflow-hidden line-clamp-3 [@media(max-height:399px)]:max-h-[24px] [@media(max-height:399px)]:leading-6 [@media(max-height:399px)]:line-clamp-1'
const LIVE_TRANSLATION_CAPTION_COMPACT_CLASS = ' max-h-[64px] overflow-hidden line-clamp-2 [@media(max-height:399px)]:max-h-[24px] [@media(max-height:399px)]:leading-6 [@media(max-height:399px)]:line-clamp-1'
const PLACEHOLDER_CAPTION_BASE_CLASS = 'text-xl font-medium leading-8'
const LIVE_PLACEHOLDER_CAPTION_CLASS = ' max-h-[64px] overflow-hidden [@media(max-height:399px)]:leading-6'
const LIVE_OVERLAY_CONTENT_CLASS = 'pointer-events-none flex h-[384px] max-h-[calc(100vh-16px)] w-full max-w-[700px] flex-col items-center justify-end gap-2 overflow-hidden'
const BATCH_OVERLAY_CONTENT_CLASS = 'pointer-events-none w-full max-w-[700px] rounded-2xl border px-6 py-4 text-center'
const LIVE_ORIGINAL_REGION_CLASS = 'max-h-[30vh] w-full max-w-[700px] shrink-0 rounded-2xl border px-6 py-3 text-center'
const LIVE_ORIGINAL_TEXT_CLASS = 'max-h-[calc(30vh-48px)] overflow-hidden break-words whitespace-pre-wrap text-left text-sm leading-6 line-clamp-3 [@media(max-height:399px)]:line-clamp-1 [@media(max-height:360px)_and_(min-height:261px)]:leading-4 [@media(max-height:260px)]:leading-3'
const LIVE_SETTLED_REGION_CLASS = 'min-h-0 max-h-[calc(70vh-24px)] w-full shrink-0 overflow-hidden rounded-2xl border px-6 py-4 text-center'

/**
 * `source` is the recognized original of dual-subtitle mode. It sits above the translation so it stays put while the
 * translation arrives below it; until then the translation line is a muted placeholder that holds its space.
 */
export function SubtitleCaption({ text, source, status, notice, error, liveText = '', liveRecognition = false }: {
  text: string
  source: string
  status: string
  notice: string
  error: string
  liveText?: string
  liveRecognition?: boolean
}) {
  const t = useT()
  const label = notice || status
  // With nothing to say the bubble is invisible but keeps its size: the overlay's render probe looks for
  // [data-overlay-content] with a non-zero box and would treat a missing one as a broken window.
  const idle = !label && !text && !source && !error
  const statusMarkup = label && (
    <p
      className={SUBTITLE_STATUS_CLASS}
      style={{ color: 'var(--overlay-text-muted)' }}
    >
      {label}
    </p>
  )
  const liveStatusClass = error ? `${LIVE_STATUS_CLASS}${LIVE_STATUS_ERROR_CLASS}` : LIVE_STATUS_CLASS
  // The settled region is capped at 256 px (70vh - 24px of a 400 px window), 222 px inside its padding and border.
  // A notice and a warning together take 108 px, leaving 114 px: three-line captions (162 px) would clip the
  // translation, while two-line captions (110 px) fit.
  const liveCompact = Boolean(notice && status)
  const liveSourceCaptionClass = liveCompact ? LIVE_SOURCE_CAPTION_COMPACT_CLASS : LIVE_SOURCE_CAPTION_CLASS
  const liveTranslationCaptionClass = liveCompact ? LIVE_TRANSLATION_CAPTION_COMPACT_CLASS : LIVE_TRANSLATION_CAPTION_CLASS
  const liveStatusMarkup = (
    <>
      {notice && (
        <p className={`mb-1 ${liveStatusClass}`} style={{ color: 'var(--overlay-text-muted)' }}>
          {notice}
        </p>
      )}
      {status && (
        <p className={`mb-2 ${liveStatusClass}`} style={{ color: 'var(--overlay-text-muted)' }}>
          {status}
        </p>
      )}
    </>
  )
  const captionMarkup = error ? (
    <p
      role="alert"
      className={liveRecognition
        ? LIVE_SUBTITLE_ERROR_CLASS
        : SUBTITLE_ERROR_CLASS}
    >
      {error}
    </p>
  ) : (
    <>
      {source && (
        <p
          className={`${SOURCE_CAPTION_BASE_CLASS}${liveRecognition ? liveSourceCaptionClass : BATCH_SOURCE_CAPTION_CLASS}`}
          style={{ color: 'var(--overlay-text-muted)' }}
        >
          {source}
        </p>
      )}
      {text ? (
        <p className={`${TRANSLATION_CAPTION_BASE_CLASS}${liveRecognition ? liveTranslationCaptionClass : ''}`}>{text}</p>
      ) : source ? (
        <p
          aria-hidden
          className={`${PLACEHOLDER_CAPTION_BASE_CLASS}${liveRecognition ? LIVE_PLACEHOLDER_CAPTION_CLASS : ''}`}
          style={{ color: 'var(--overlay-text-muted)' }}
        >…</p>
      ) : null}
    </>
  )
  const cardStyle = idle
    ? { background: 'transparent', color: 'var(--overlay-text)', borderColor: 'transparent' }
    : { background: 'var(--overlay-bg)', color: 'var(--overlay-text)', borderColor: 'var(--overlay-border)' }

  const liveSettledVisible = Boolean(label || text || source || error)

  return (
    <div
      data-overlay-content
      className={liveRecognition
        ? LIVE_OVERLAY_CONTENT_CLASS
        : BATCH_OVERLAY_CONTENT_CLASS}
      style={liveRecognition ? undefined : cardStyle}
    >
      {liveRecognition && liveText && (
        <div
          data-live-original
          className={LIVE_ORIGINAL_REGION_CLASS}
          style={{ background: 'var(--overlay-bg)', color: 'var(--overlay-text)', borderColor: 'var(--overlay-border)' }}
        >
          <p className="mb-1 whitespace-nowrap text-[11px] font-medium tracking-wide" style={{ color: 'var(--overlay-text-muted)' }}>
            {t('systemAudio.liveOriginalLabel')}
          </p>
          <p className={LIVE_ORIGINAL_TEXT_CLASS}>
            {liveText}
          </p>
        </div>
      )}
      {liveRecognition ? (
        liveSettledVisible ? (
          <div
            data-overlay-settled
            className={LIVE_SETTLED_REGION_CLASS}
            style={cardStyle}
          >
            {liveStatusMarkup}
            {captionMarkup}
          </div>
        ) : null
      ) : (
        <>
          {statusMarkup}
          {captionMarkup}
        </>
      )}
    </div>
  )
}

interface OverlayFailureCardProps {
  title: string
  detail: string
  recovery: 'unknown' | 'history' | 'none'
  warning?: string
  onDismiss: () => void
}

export function OverlayFailureCard({ title, detail, recovery, warning, onDismiss }: OverlayFailureCardProps) {
  const t = useT()
  const recoveryText = recovery === 'history'
    ? t('overlay.failureRecoveryHistory')
    : recovery === 'none'
      ? t('overlay.failureRecoveryNone')
      : ''

  return (
    <div
      data-overlay-content
      className={`pointer-events-auto flex w-full max-w-[480px] flex-col rounded-xl border p-4${warning ? ' max-h-[calc(100vh-16px)] overflow-y-auto' : ''}`}
      style={{
        background: 'var(--overlay-bg)',
        color: 'var(--overlay-text)',
        borderColor: 'var(--overlay-border)',
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="min-w-0 text-sm font-semibold leading-5">{title}</h2>
        <button
          type="button"
          onClick={onDismiss}
          title={t('window.close')}
          aria-label={t('overlay.dismissFailure')}
          className="-mr-1 -mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/60 transition-colors hover:bg-white/15 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <p className="mt-2 max-h-[64px] overflow-auto pr-1 text-sm leading-5 select-text">
        {detail}
      </p>
      {warning && <p role="status" className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-amber-300">{warning}</p>}
      {recoveryText && (
        <p className="mt-2 text-xs leading-4" style={{ color: 'var(--overlay-text-dim)' }}>
          {recoveryText}
        </p>
      )}
    </div>
  )
}

export default function Overlay() {
  const t = useT()
  const [state, setState] = useState<OverlayState>('waiting')
  const [recordingVisualPhase, setRecordingVisualPhase] = useState<RecordingVisualPhase>('preparing')
  const [bars, setBars] = useState<number[]>(IDLE_BARS)
  const [elapsedSec, setElapsedSec] = useState(0)
  const [theme, setTheme] = useState<OverlayWaveTheme>(DEFAULT_WAVE_THEME)
  const [customWave, setCustomWave] = useState<CustomWaveColors>(DEFAULT_CUSTOM_WAVE)
  const [showDuration, setShowDuration] = useState(true)
  const [barCount, setBarCount] = useState(DEFAULT_BAR_COUNT)
  const [presentationId, setPresentationId] = useState(0)
  const [presentationEntrance, setPresentationEntrance] = useState<'circle' | 'pill'>('pill')
  const [fallbackText, setFallbackText] = useState('')
  const [failureTitle, setFailureTitle] = useState('')
  const [failureDetail, setFailureDetail] = useState('')
  const [failureRecovery, setFailureRecovery] = useState<'unknown' | 'history' | 'none'>('unknown')
  const [failureToken, setFailureToken] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [toastText, setToastText] = useState('')
  const [toastTone, setToastTone] = useState<'info' | 'warn'>('info')
  const [streamingText, setStreamingText] = useState('')
  const [streamingOn, setStreamingOn] = useState(false)
  const [subtitleText, setSubtitleText] = useState('')
  const [subtitleStatus, setSubtitleStatus] = useState('')
  const [subtitleError, setSubtitleError] = useState('')
  const [subtitleNotice, setSubtitleNotice] = useState('')
  const [subtitleSource, setSubtitleSource] = useState('')
  const [subtitleLiveText, setSubtitleLiveText] = useState('')
  const [subtitleLiveRecognition, setSubtitleLiveRecognition] = useState(false)
  const [copied, setCopied] = useState(false)
  const [thinkingDuration, setThinkingDuration] = useState(0)
  const [thinkingAi, setThinkingAi] = useState(false)
  const [warning, setWarning] = useState('')
  const [warningTone, setWarningTone] = useState<'warn' | 'error'>('warn')
  const [micSourceMode, setMicSourceMode] = useState<'auto' | 'fixed' | null>(null)
  const [micSourceLabel, setMicSourceLabel] = useState('')
  // The overlay WebView is created hidden and WebView2 keeps it "visible" while hidden, so its
  // CSS animations would keep running in the tray. Start paused; any overlay-state payload resumes
  // them and overlay-hidden pauses them again.
  const [animationsPaused, setAnimationsPaused] = useState(true)
  // WebView2 keeps compositing the hidden overlay, and native present shows the window before the new
  // state renders, so the next show would open on this show's last frame (the waveform after a short
  // tap, "Processing" after a dictation). Render nothing while hidden; the waking payload renders the
  // new state in the same commit.
  const [overlayBlank, setOverlayBlank] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const pillRef = useRef<HTMLDivElement | null>(null)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const preparingPaintFrameRef = useRef<number | null>(null)
  const preparingHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingListeningVisualRef = useRef(false)
  // Whether listening may replace the preparing circle on screen. It stays open until a waiting
  // closes it; a listening that arrives while it is closed is deferred.
  const preparingGateOpenRef = useRef(true)
  const preparingShowIdRef = useRef<number | null>(null)
  const elapsedSecRef = useRef(0)
  const shownIdRef = useRef(0)
  // Whether the overlay document currently shows a state (a payload with a non-zero show id was
  // received and no overlay-hidden has cleared it). A new show while already visible is a content
  // change inside the same visible window, so it must morph instead of replaying the surface
  // entrance, except for a recording attempt (waiting), which always starts its own presentation
  // with the circle entrance; a show after overlay-hidden starts a fresh presentation.
  const overlayVisibleRef = useRef(false)

  // 根据录音时长计算预估处理时间（秒）
  const calculateThinkingDuration = (recordingSec: number): number => {
    if (recordingSec <= 5) return 2
    if (recordingSec <= 15) return 3
    if (recordingSec <= 30) return 4
    if (recordingSec <= 60) return 5
    if (recordingSec <= 120) return 7
    if (recordingSec <= 180) return 9
    if (recordingSec <= 240) return 11
    return 13 // 240秒以上（4-5分钟）
  }

  useEffect(() => {
    let disposed = false
    let removeOverlayListener: (() => void) | null = null
    let removeHiddenListener: (() => void) | null = null

    const cancelPreparingGate = () => {
      if (preparingPaintFrameRef.current !== null) {
        cancelAnimationFrame(preparingPaintFrameRef.current)
        preparingPaintFrameRef.current = null
      }
      if (preparingHoldTimerRef.current !== null) {
        clearTimeout(preparingHoldTimerRef.current)
        preparingHoldTimerRef.current = null
      }
      pendingListeningVisualRef.current = false
      preparingGateOpenRef.current = true
      preparingShowIdRef.current = null
    }

    const openPreparingGate = () => {
      preparingGateOpenRef.current = true
      if (disposed || !pendingListeningVisualRef.current) return
      pendingListeningVisualRef.current = false
      setRecordingVisualPhase('listening')
    }

    const beginPreparingVisual = (showId: number | undefined) => {
      // A repeated waiting for the same show (for example a republished microphone hint) must not
      // restart the hold.
      if (preparingShowIdRef.current !== null && preparingShowIdRef.current === showId) return
      cancelPreparingGate()
      preparingShowIdRef.current = showId ?? null
      preparingGateOpenRef.current = false
      setRecordingVisualPhase('preparing')
      const holdMs = motionAllowed() ? MIN_PREPARING_VISUAL_MS : 0
      const startedAt = performance.now()
      let framesLeft = 2
      // listening can arrive before the WebView's first frame. Allow the visual switch only after two rAFs,
      // so the preparing circle is actually painted for at least one frame; this delays only the visual
      // morph, not audio capture. With animations on, the circle also stays for at least
      // MIN_PREPARING_VISUAL_MS: listening usually arrives ~15 ms after waiting, and a circle that
      // stretches after one or two frames reads as a jerk rather than an entrance.
      const waitForPaint = () => {
        framesLeft -= 1
        if (framesLeft > 0) {
          preparingPaintFrameRef.current = requestAnimationFrame(waitForPaint)
          return
        }
        preparingPaintFrameRef.current = null
        const remaining = holdMs - (performance.now() - startedAt)
        if (remaining <= 0) {
          openPreparingGate()
          return
        }
        preparingHoldTimerRef.current = setTimeout(() => {
          preparingHoldTimerRef.current = null
          openPreparingGate()
        }, remaining)
      }
      preparingPaintFrameRef.current = requestAnimationFrame(waitForPaint)
    }

    const handleOverlayState = (data: unknown) => {
      const payload = data as OverlayPayload
      // The overlay is its own document, so the in-app switch travels with the payload. Update the
      // module/attribute before the state changes below are rendered.
      if (typeof payload.animationsEnabled === 'boolean') setMotionEnabled(payload.animationsEnabled)
      // A late update for an already hidden show arrives with show id 0 and must not wake the
      // hidden page; with id 0 the window is shown only for the interactive fallback card.
      if (payload._overlayShowId !== 0 || payload.state === 'fallback') {
        setAnimationsPaused(false)
        setOverlayBlank(false)
      }
      if (typeof payload._overlayShowId === 'number') {
        shownIdRef.current = payload._overlayShowId
        if (payload._overlayShowId !== 0) {
          // Keep the current presentationId while the window is already visible: a toast or error
          // presented after processing has a new show id, but the pill is already on screen and
          // must morph rather than re-enter. The new id still goes into shownIdRef so the matching
          // overlay-hidden is accepted later. A recording attempt (waiting) is the exception: each
          // one starts its own presentation with the circle entrance, even while visible.
          if (!overlayVisibleRef.current || payload.state === 'waiting') {
            setPresentationId(payload._overlayShowId)
            setPresentationEntrance(payload.state === 'waiting' ? 'circle' : 'pill')
          }
          overlayVisibleRef.current = true
        }
      }
      // 语言先落地再渲染本帧：悬浮窗没有自己的初始化时机，语言只能随 payload 来。
      // setLocale 对同值是空操作，所以每帧都调也不会造成额外重渲染。
      if (isLocale(payload.locale)) setLocale(payload.locale)
      const nextElapsedSec = typeof payload.elapsedSec === 'number'
        ? payload.elapsedSec
        : elapsedSecRef.current

      if (payload.state) {
        if (payload.state === 'waiting') {
          beginPreparingVisual(payload._overlayShowId)
        } else if (payload.state === 'listening') {
          if (!preparingGateOpenRef.current) {
            pendingListeningVisualRef.current = true
          } else {
            setRecordingVisualPhase('listening')
          }
        } else {
          cancelPreparingGate()
        }
        setState(payload.state)
        // Every state presentation decides the flag: a full thinking update without the field
        // means the run is not AI-processed, and leaving thinking clears it.
        setThinkingAi(payload.state === 'thinking' && payload.thinkingAi === true)
        if (payload.state !== 'listening') {
          setBars((prev) => Array(prev.length).fill(3))
          // 离开录音状态即清空实时文字气泡
          setStreamingText('')
          setStreamingOn(false)
        }
        setCopied(false)
        if (payload.state !== 'fallback' && hideTimerRef.current) {
          clearTimeout(hideTimerRef.current)
          hideTimerRef.current = null
        }
        if (payload.state === 'thinking') {
          setThinkingDuration(calculateThinkingDuration(nextElapsedSec))
        }
      }

      if (Array.isArray(payload.bars) && payload.bars.length > 0) setBars(payload.bars)
      if (typeof payload.elapsedSec === 'number') {
        elapsedSecRef.current = payload.elapsedSec
        setElapsedSec(payload.elapsedSec)
      }
      if (typeof payload.showDuration === 'boolean') setShowDuration(payload.showDuration)
      if (payload.theme) setTheme(normalizeWaveTheme(payload.theme))
      if (payload.customWave) {
        // Every frame's payload carries a freshly deserialized object. Keep the previous reference
        // when the colors are unchanged, otherwise the palette memo below would be rebuilt on every frame.
        const next = normalizeCustomWave(payload.customWave)
        setCustomWave((prev) => (sameCustomWave(prev, next) ? prev : next))
      }
      if (typeof payload.barCount === 'number' && payload.barCount > 0) setBarCount(payload.barCount)
      if (typeof payload.fallbackText === 'string') setFallbackText(payload.fallbackText)
      if (typeof payload.failureTitle === 'string') setFailureTitle(payload.failureTitle)
      if (typeof payload.failureDetail === 'string') setFailureDetail(payload.failureDetail)
      if (payload.failureRecovery === 'unknown' || payload.failureRecovery === 'history' || payload.failureRecovery === 'none') {
        setFailureRecovery(payload.failureRecovery)
      }
      if (typeof payload.cardToken === 'number') setFailureToken(payload.cardToken)
      if (typeof payload.errorMessage === 'string') setErrorMessage(payload.errorMessage)
      if (typeof payload.toastText === 'string') setToastText(payload.toastText)
      if (payload.toastTone === 'info' || payload.toastTone === 'warn') setToastTone(payload.toastTone)
      if (typeof payload.warning === 'string') setWarning(payload.warning)
      if (payload.warningTone === 'warn' || payload.warningTone === 'error') setWarningTone(payload.warningTone)
      if (typeof payload.streamingText === 'string') setStreamingText(payload.streamingText)
      if (typeof payload.subtitleText === 'string') setSubtitleText(payload.subtitleText)
      if (typeof payload.subtitleStatus === 'string') setSubtitleStatus(payload.subtitleStatus)
      if (typeof payload.subtitleError === 'string') setSubtitleError(payload.subtitleError)
      if (typeof payload.subtitleNotice === 'string') setSubtitleNotice(payload.subtitleNotice)
      if (typeof payload.subtitleSource === 'string') setSubtitleSource(payload.subtitleSource)
      setSubtitleLiveText(typeof payload.subtitleLiveText === 'string' ? payload.subtitleLiveText : '')
      setSubtitleLiveRecognition(payload.subtitleLiveRecognition === true)
      if (typeof payload.streaming === 'boolean') setStreamingOn(payload.streaming)
      if (payload.micSourceMode === 'auto' || payload.micSourceMode === 'fixed' || payload.micSourceMode === null) {
        setMicSourceMode(payload.micSourceMode)
      }
      if (typeof payload.micSourceLabel === 'string') setMicSourceLabel(payload.micSourceLabel)
      if (payload.state === 'waiting') {
        setElapsedSec(0)
        setWarning('')
        setWarningTone('warn')
        setStreamingText('')
        setStreamingOn(false)
        setMicSourceMode(null)
        setMicSourceLabel('')
        setBars((prev) => Array(prev.length).fill(3))
      }

      if (!payload._overlayProbe) return
      const showId = payload._overlayShowId
      const generation = payload._overlayGeneration
      if (typeof showId !== 'number' || typeof generation !== 'number') return

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (disposed) return
          const root = rootRef.current
          const content = root?.querySelector<HTMLElement>('[data-overlay-content]') ?? null
          const rootRect = root?.getBoundingClientRect()
          const contentRect = content?.getBoundingClientRect()
          const style = content ? window.getComputedStyle(content) : null
          const healthy = Boolean(
            rootRect && contentRect
            && rootRect.width > 0 && rootRect.height > 0
            && contentRect.width > 0 && contentRect.height > 0
            && style?.display !== 'none'
            && style?.visibility !== 'hidden'
            && Number(style?.opacity ?? '1') > 0
          )
          void bridge.overlayRenderAck({
            showId,
            generation,
            healthy,
            overlayState: payload.state ?? 'unknown',
            documentVisibility: document.visibilityState,
            rootWidth: rootRect?.width ?? 0,
            rootHeight: rootRect?.height ?? 0,
            contentWidth: contentRect?.width ?? 0,
            contentHeight: contentRect?.height ?? 0,
            display: style?.display ?? 'missing',
            visibility: style?.visibility ?? 'missing',
            opacity: style?.opacity ?? 'missing',
          }).catch(() => { })
        })
      })
    }

    const handleOverlayHidden = (data: unknown) => {
      const showId = (data as { showId?: unknown } | null)?.showId
      // A hide for an earlier show can arrive after the next show's state; ignore it.
      if (typeof showId === 'number' && showId !== shownIdRef.current) return
      overlayVisibleRef.current = false
      setAnimationsPaused(true)
      setOverlayBlank(true)
    }

    void bridge.listen<unknown>('overlay-state', (event) => handleOverlayState(event.payload))
      .then((unlisten) => {
        if (disposed) {
          unlisten()
          return
        }
        removeOverlayListener = unlisten
        void bridge.overlayReady().catch(() => { })
      })

    void bridge.listen<unknown>('overlay-hidden', (event) => handleOverlayHidden(event.payload))
      .then((unlisten) => {
        if (disposed) {
          unlisten()
          return
        }
        removeHiddenListener = unlisten
      })

    return () => {
      disposed = true
      cancelPreparingGate()
      removeOverlayListener?.()
      removeHiddenListener?.()
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current)
        hideTimerRef.current = null
      }
    }
  }, [])

  const recordingPhase = state === 'waiting' || state === 'listening'
  const visuallyListening = state === 'listening' && recordingVisualPhase === 'listening'
  const showStreamingBubble = visuallyListening && (streamingOn || streamingText.trim().length > 0)
  const hasStreamingText = streamingText.trim().length > 0
  const showMicSourceHint = Boolean(
    micSourceMode
    && micSourceLabel.trim()
    && (visuallyListening || state === 'thinking'),
  )

  const { text: timerText, countdown: inCountdown, remainingSec } = useMemo(
    () => formatRecordingTimer(elapsedSec),
    [elapsedSec],
  )
  // 越接近上限越醒目，但不用刺眼的纯红：琥珀 → 暖橙，最后 10 秒再叠一层脉动。
  // 悬浮窗是黑底小尺寸，纯红（#f87171）在这上面又艳又跳，和整体配色不搭。
  const urgent = inCountdown && remainingSec <= 10
  // 胶囊宽度按波形条数固定，文字挤进来时按需让出条数：
  //   · 同时有警告文字 + 倒计时 → 只画一半（最少 4 根，太少就不像波形了）
  //   · 只有其中一种 → 画三分之二
  // 这样波形始终是完整的整根条，不会被裁成半截。
  const normalizedBars = barCount === bars.length
    ? bars
    : Array.from({ length: barCount }, (_, index) => bars[index] ?? 3)
  const barBudget = warning && inCountdown
    ? Math.max(4, Math.floor(normalizedBars.length / 2))
    : (warning || inCountdown
      ? Math.max(6, Math.floor((normalizedBars.length * 2) / 3))
      : normalizedBars.length)
  const visibleBars = barBudget >= normalizedBars.length
    ? normalizedBars
    : normalizedBars.slice(0, barBudget)

  // Recording re-renders about 30 times per second, but the palette only changes with the theme, the
  // custom colors or the bar count, and custom colors need an OKLCH conversion per bar, so it is memoized.
  // It is built for normalizedBars.length, the same length visibleBars is a prefix of, so
  // palette[index] is defined for every rendered bar.
  const palette = useMemo(
    () => buildWavePalette(normalizedBars.length, theme, customWave),
    [normalizedBars.length, theme, customWave],
  )
  const themeTimerColor = useMemo(() => getWaveTimerColor(theme, customWave), [theme, customWave])
  const thinkingColor = useMemo(() => getWaveThinkingColor(theme, customWave), [theme, customWave])
  const timerColor = inCountdown
    ? (urgent ? '#fb923c' : '#fbbf24')
    : themeTimerColor

  // Identifier for "the pill shows a different kind of content". waiting/listening share one:
  // per-frame recording refreshes are not a content change, and the expansion between them is
  // handled by the surface insets and the content clip (overlay-pill-recording-* in index.css).
  // Notices include their text, so two different notices in a row morph too.
  // A warning appearing/disappearing and the countdown starting make the waveform give up bars
  // (see barBudget), so the width changes; they belong to the width key, while the recording
  // content itself is not remounted and contentKey stays the same.
  const pillContentKey = recordingPhase ? 'recording' : state === 'thinking' ? 'thinking' : null
  const pillMorphKey = recordingPhase
    ? `recording:${warningTone}:${warning}:${inCountdown ? 1 : 0}`
    : state === 'thinking'
      ? `thinking:${thinkingAi ? 'ai' : ''}`
      : state === 'toast'
        ? `toast:${toastTone}:${toastText}`
        : state === 'error'
          ? `error:${errorMessage}`
          : state
  const { animateContent: animatePillContent, enteredFrom: pillEnteredFrom } = usePillMorph(
    pillRef,
    pillMorphKey,
    presentationId,
    pillContentKey ?? pillMorphKey,
  )

  // "Waveform collapses into the progress bar" needs the last waveform frame before the recording
  // ended. By the time the recording state is left, bars are already reset to 3, so record them
  // frame by frame during recording. A muted-microphone alert draws red text instead of the
  // waveform, so there is nothing to collapse in that case.
  const waveSnapshotRef = useRef<{ heights: number[]; colors: string[] } | null>(null)
  // The snapshot is consumed once, when the thinking state starts. Without this gate a later
  // re-render (for example when animations are switched back on mid-processing) could mount the
  // collapse row late and replay it over the already running progress bar.
  const collapseSnapshotRef = useRef<{ heights: number[]; colors: string[] } | null>(null)
  const collapseCapturedRef = useRef(false)
  const collapsePresentationRef = useRef(presentationId)
  if (collapsePresentationRef.current !== presentationId) {
    // A new show: any snapshot belongs to the previous presentation.
    collapsePresentationRef.current = presentationId
    collapseSnapshotRef.current = null
    collapseCapturedRef.current = false
  }
  if (visuallyListening) {
    waveSnapshotRef.current = warning && warningTone === 'error'
      ? null
      : { heights: visibleBars, colors: palette }
  } else if (state === 'waiting') {
    // Clear it when a new recording starts. Otherwise press-and-release (before any waveform was
    // drawn) would replay the previous recording's snapshot when processing begins.
    waveSnapshotRef.current = null
  }
  const motion = useMotionAllowed()
  if (state === 'thinking') {
    if (!collapseCapturedRef.current) {
      collapseCapturedRef.current = true
      const frame = waveSnapshotRef.current
      collapseSnapshotRef.current = motion && pillEnteredFrom === 'recording' && frame !== null
        ? { heights: frame.heights, colors: frame.colors }
        : null
    }
  } else {
    // Leaving thinking (or being outside it) resets the one-shot gate, so the next thinking state
    // captures its own frame. Keeping the gate across a visible toast and a following recording
    // would reuse the previous recording's snapshot forever because a visible present keeps the
    // same presentationId.
    collapseCapturedRef.current = false
    collapseSnapshotRef.current = null
  }
  // With interface animations off the snapshot is never captured: its bars would jump to the end
  // state and the row would vanish at once, which looks worse than not showing it. Once captured
  // (or skipped), the decision is final for this thinking state.
  const waveSnapshot = collapseSnapshotRef.current
  const showWaveCollapse = state === 'thinking' && waveSnapshot !== null

  const handleCopyFallback = async () => {
    if (!fallbackText) return

    try {
      await bridge.copyText(fallbackText)
      setCopied(true)
      addRuntimeEvent('info', 'overlay', 'Fallback card copied', { textLen: fallbackText.length })

      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current)
      }
      hideTimerRef.current = setTimeout(() => {
        void bridge.setEscapeActionMode('off')
        void bridge.hideOverlay()
        hideTimerRef.current = null
      }, 500)
    } catch (error) {
      addRuntimeEvent('error', 'overlay', 'Fallback card copy failed', { error: String(error) })
    }
  }

  const handleDismissFallback = () => {
    addRuntimeEvent('info', 'overlay', 'Fallback card dismissed by user')
    void bridge.setEscapeActionMode('off')
    void bridge.hideOverlay()
  }

  return (
    <div
      ref={rootRef}
      data-overlay-animations-paused={animationsPaused ? '' : undefined}
      className="pointer-events-none flex h-full items-end justify-center pb-4"
    >
      {!overlayBlank && (state === 'failure' ? (
        <OverlayFailureCard
          title={failureTitle}
          detail={failureDetail}
          recovery={failureRecovery}
          warning={warning}
          onDismiss={() => {
            addRuntimeEvent('info', 'overlay', 'Failure card dismissed by user', { token: failureToken })
            void bridge.dismissOverlayCard(failureToken).catch((error) => {
              addRuntimeEvent('warn', 'overlay', 'Failed to notify controller about card dismissal', {
                token: failureToken,
                error: String(error),
              })
            })
          }}
        />
      ) : state === 'subtitles' ? (
        <SubtitleCaption
          text={subtitleText}
          source={subtitleSource}
          status={subtitleStatus}
          notice={subtitleNotice}
          error={subtitleError}
          liveText={subtitleLiveText}
          liveRecognition={subtitleLiveRecognition}
        />
      ) : state === 'fallback' ? (
        <div
          data-overlay-content
          className={`pointer-events-auto flex w-full max-w-[520px] flex-col rounded-xl border px-4 py-4${warning ? ' max-h-[calc(100vh-16px)] overflow-y-auto' : ''}`}
          style={{
            background: 'var(--overlay-bg)',
            color: 'var(--overlay-text)',
            borderColor: 'var(--overlay-border)',
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <span className="block text-xs font-medium tracking-[0.16em]" style={{ color: 'var(--overlay-text-muted)' }}>{t('overlay.recognizedText')}</span>
              <span className="block text-xs" style={{ color: 'var(--overlay-text-dim)' }}>
                {t('overlay.fallbackHint')}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={handleCopyFallback}
                title={copied ? t('overlay.copied') : t('overlay.copyText')}
                className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-colors ${copied
                  ? 'border-emerald-400/40 bg-emerald-500/15 text-emerald-200'
                  : 'border-white/10 bg-white/10 text-white/90 hover:bg-white/20'
                  }`}
              >
                {copied ? <SuccessCheck className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </button>
              <button
                type="button"
                onClick={handleDismissFallback}
                title={t('window.close')}
                aria-label={t('overlay.dismissAria')}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/60 transition-colors hover:bg-white/15 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="mt-4 flex-1 overflow-hidden rounded-lg px-3 py-3" style={{ background: 'var(--overlay-surface)' }}>
            <p className="max-h-[108px] overflow-auto pr-1 text-sm leading-6 select-text">
              {fallbackText || t('overlay.noText')}
            </p>
          </div>
          {warning && <p role="status" className="mt-3 whitespace-pre-wrap break-words text-xs leading-5 text-amber-300">{warning}</p>}
        </div>
      ) : (
        <div
          data-overlay-content
          className="flex flex-col items-center gap-2"
        >
          {showMicSourceHint && (
            <div
              className="pointer-events-none flex min-w-0 max-w-[calc(100vw-16px)] items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-full border px-3 py-1.5 font-normal"
              style={{
                background: 'rgba(11, 11, 12, 0.94)',
                color: 'var(--overlay-text)',
                borderColor: 'var(--overlay-border)',
                boxShadow: '0 2px 10px rgba(0, 0, 0, 0.2)',
                backdropFilter: 'blur(8px)',
              }}
            >
              <MicVocal
                className="h-3.5 w-3.5 shrink-0"
                strokeWidth={1.8}
                style={{ color: '#ffffff' }}
                aria-hidden
              />
              <span className="min-w-0 truncate text-xs font-normal" style={{ color: '#ffffff' }}>
                {micSourceLabel}
              </span>
            </div>
          )}
          {showStreamingBubble && (
            <div
              className="pointer-events-none relative flex max-w-[440px] flex-col rounded-2xl border px-4 py-2.5"
              style={{
                background: 'var(--overlay-bg)',
                color: 'var(--overlay-text)',
                borderColor: 'var(--overlay-border)',
              }}
            >
              <span
                className="mb-1 text-[10px] font-medium tracking-[0.18em]"
                style={{ color: 'var(--overlay-text-muted)' }}
              >
                {t('overlay.liveCaption')}
              </span>
              {/* 内容驱动尺寸：小默认，随文字增行慢慢变大，超过 3 行才滚动，只显示最新内容 */}
              <div
                className="flex max-h-[72px] flex-col justify-end overflow-hidden text-left text-sm leading-6"
                style={{ color: hasStreamingText ? 'var(--overlay-text)' : 'var(--overlay-text-dim)' }}
              >
                <div>
                  {hasStreamingText ? streamingText : t('overlay.listening')}
                  {hasStreamingText && (
                    <span
                      className="ml-0.5 inline-block h-[1.05em] w-[2px] rounded-full align-middle"
                      style={{
                        backgroundColor: 'var(--overlay-text)',
                        animation: 'caret-blink 1.1s ease-in-out infinite',
                      }}
                    />
                  )}
                </div>
              </div>
              {/* 底部朝下尖角：提示文字来自下方的录音胶囊 */}
              <span
                className="absolute left-1/2 h-0 w-0 -translate-x-1/2"
                style={{
                  bottom: '-7px',
                  borderLeft: '7px solid transparent',
                  borderRight: '7px solid transparent',
                  borderTop: '7px solid var(--overlay-bg)',
                }}
              />
            </div>
          )}
          {/* The pill: the window width is fixed by the waveform bar count, so wrapping must be disabled here.
              Otherwise, with more text (for example "28s left" plus "Move closer to the microphone" at the same
              time), it would break into two lines and burst the rounded corners. When content overflows, the
              **waveform** gives way (see min-w-0 + overflow-hidden on the bars container below) and the text stays
              whole: the text is information, the waveform is only decoration. */}
          {/* max-w is the other half of this: the root container is justify-center, so once the pill content gets
              wider it overflows to both sides and is cut off by the window, looking like a rounded rectangle with
              both ends sliced flat. With a width cap, the squeeze is passed on to the waveform (min-w-0 on the
              bars), and the pill itself always keeps its full capsule shape. 100vw rather than max-w-full: the
              parent's width is also content-sized, so it cannot provide the constraint. */}
          <div
            ref={pillRef}
            key={presentationId}
            className={`relative flex max-w-[calc(100vw-8px)] items-center overflow-hidden whitespace-nowrap rounded-full px-4 py-2${recordingPhase && recordingVisualPhase === 'preparing' ? ' overlay-pill-recording-waiting' : ''}${recordingPhase && recordingVisualPhase === 'listening' ? ' overlay-pill-recording-listening' : ''}${presentationEntrance === 'circle' ? ' overlay-pill-enter-circle' : ''}`}
            style={{ minHeight: '38px' }}
          >
            <span
              aria-hidden
              className={`overlay-pill-surface absolute inset-0 rounded-full border${presentationEntrance === 'pill' ? ' overlay-pill-surface-enter' : ''}`}
              style={{
                background: 'var(--overlay-bg)',
                borderColor: 'var(--overlay-border)',
              }}
            />
            {/* Last waveform frame, kept at natural size while it settles: each bar eases down to
                a thin line and the whole row fades out (overlay-wave-collapse in index.css). Kept
                **outside** the processing content: that layer has its own entrance animation and
                would fade this one together with it. left 16px = the pill's px-4, aligned with the
                waveform and progress bar start; once faded it stays in the DOM transparent, which
                is harmless. */}
            {showWaveCollapse && waveSnapshot && (
              <div
                aria-hidden
                className="overlay-wave-collapse pointer-events-none absolute z-[1] flex items-center gap-[2px]"
                style={{
                  left: '16px',
                  top: '50%',
                  height: '20px',
                  marginTop: '-10px',
                }}
              >
                {waveSnapshot.heights.map((height, index) => {
                  const clampedHeight = Math.min(18, Math.max(3, height))
                  return (
                    <span
                      key={index}
                      className="overlay-wave-collapse-bar block w-[2.5px] rounded-full"
                      style={{
                        backgroundColor: waveSnapshot.colors[index],
                        height: `${clampedHeight}px`,
                        opacity: 0.7 + (clampedHeight / 18) * 0.3,
                        '--from-h': `${clampedHeight}px`,
                      } as CSSProperties}
                    />
                  )
                })}
              </div>
            )}
            {recordingPhase ? (
              <div
                className="overlay-recording-stage relative z-[1] min-w-0"
                style={{ color: 'var(--overlay-text)' }}
              >
                <div className="overlay-preparing-indicator" aria-hidden>
                  {[0, 1, 2].map((index) => (
                    <span
                      key={index}
                      className="overlay-preparing-dot rounded-full"
                      style={{ animationDelay: `${index * 110}ms` }}
                    />
                  ))}
                </div>
                <div
                  className="overlay-recording-content flex min-w-0 items-center"
                  aria-hidden={recordingVisualPhase !== 'listening'}
                >
                  {warning && warningTone === 'error' ? (
                    // Muted-microphone alert: the waveform is flat and meaningless here, so show
                    // the red text centered inside the pill. It is more noticeable and also avoids
                    // a long warning plus the waveform breaking the fixed width and clipping the
                    // pill's rounded corners.
                    <div
                      key={warning}
                      className="overlay-attention flex items-center whitespace-nowrap px-1 text-xs font-semibold text-red-500"
                      style={{ height: '20px' }}
                    >
                      {warning}
                    </div>
                  ) : (
                    <>
                      {/* 有文字要占位时**少画几根**，而不是让 overflow 把波形裁一半 —— 裁出来的
                          半根条子看着像坏了。少画是"看起来就是这么设计的"。
                          min-w-0 仍然留着兜底：万一文字特别长，宁可裁波形也不折行。 */}
                      <div className="flex min-w-0 items-center gap-[2px] overflow-hidden" style={{ height: '20px' }}>
                        {visibleBars.map((height, index) => {
                          const color = palette[index]
                          return (
                            <div
                              key={index}
                              className="w-[2.5px] rounded-full"
                              style={{
                                backgroundColor: color,
                                boxShadow: 'none',
                                height: `${Math.min(18, Math.max(3, height))}px`,
                                opacity: 0.7 + (Math.min(18, height) / 18) * 0.3,
                                transition: 'height 50ms ease-out, opacity 50ms ease-out',
                              }}
                            />
                          )
                        })}
                      </div>
                      {/* The timer is **no longer** pushed out by a warning: a warning is a
                          fleeting notice, the timer is an ongoing state. The condition used to
                          include !warning, so when the 4-minute hint appeared the seconds stayed
                          hidden for the whole remaining minute. */}
                      {showDuration && (
                        <span
                          className={`ml-1.5 shrink-0 whitespace-nowrap text-right font-mono tabular-nums text-xs${inCountdown ? ' font-semibold' : ''}${urgent ? ' overlay-breathe' : ''}`}
                          style={{ color: timerColor }}
                        >
                          {timerText}
                        </span>
                      )}
                      {warning && (
                        <span key={warning} className="overlay-attention ml-2 shrink-0 whitespace-nowrap text-xs text-amber-400">
                          {warning}
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>
            ) : (
              // key gives each kind of content its own mount so the entrance animation replays when
              // the content changes within one show. A new show is animated by the surface entrance
              // instead; the content itself does not replay there.
              <div
                key={pillContentKey ?? pillMorphKey}
                className={`relative z-[1] flex min-w-0 items-center${animatePillContent ? ' overlay-pill-content-enter' : ''}`}
                style={{ color: 'var(--overlay-text)' }}
              >
                {state === 'thinking' && (
                  <div className="flex items-center gap-2">
                    {/* Three-stage progress (estimate → creep → sheen); the animation definitions
                        and the reasoning are in index.css under overlay-progress-*. --estimate is
                        the estimated duration, and both later stages start their delay from it. */}
                    <div
                      className="relative h-1 w-12 overflow-hidden rounded-full bg-white/10"
                      style={{ '--estimate': `${thinkingDuration}s` } as CSSProperties}
                    >
                      {motion ? (
                        <>
                          <div className="overlay-progress-estimate absolute inset-0">
                            <div
                              className="overlay-progress-creep absolute inset-0 rounded-full"
                              style={{ backgroundColor: thinkingColor }}
                            />
                          </div>
                          <div className="overlay-progress-sheen absolute inset-y-0 left-0 rounded-full" aria-hidden />
                        </>
                      ) : (
                        // With animations off the bar must still say "processing" without moving:
                        // a static estimate line, no creep and no sheen.
                        <div
                          className="overlay-progress-static h-full w-[86%] rounded-full"
                          style={{ backgroundColor: thinkingColor }}
                        />
                      )}
                    </div>
                    {/* The sparkle pulses; the pill keeps its progress animation and the user's wave theme. */}
                    <span className="flex items-center gap-1 text-xs whitespace-nowrap" style={{ color: thinkingColor }}>
                      {thinkingAi && (
                        <Sparkles aria-hidden className="overlay-ai-sparkle h-3.5 w-3.5 shrink-0" strokeWidth={2.2} />
                      )}
                      {t(thinkingAi ? 'overlay.processingAi' : 'overlay.processing')}
                    </span>
                    {/* "Esc to cancel" is **deliberately** not written here. Esc cancel still
                        works (native hook + escape-action, unrelated to this component); this
                        hint simply does not belong on the overlay: the overlay sits near the
                        caret and flashes on every dictation, so quieter is better, and "Esc can
                        cancel" is a fact you learn once. It is explained statically in
                        Settings → Keyboard shortcuts (see GeneralSettingsPage). Think before
                        adding it back: it would appear on every processing step, but helps only
                        the first time. */}
                  </div>
                )}

                {state === 'error' && (
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate whitespace-nowrap text-xs text-red-400" title={errorMessage || t('overlay.genericError')}>
                      {errorMessage || t('overlay.genericError')}
                    </span>
                  </div>
                )}

                {state === 'toast' && (
                  <div className="flex min-w-0 items-center gap-2">
                    {toastTone === 'warn' ? (
                      <span className="truncate whitespace-nowrap text-xs text-amber-400" title={toastText}>{toastText}</span>
                    ) : (
                      <span className="truncate whitespace-nowrap text-xs" style={{ color: 'var(--overlay-text)' }} title={toastText}>
                        {toastText}
                      </span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
