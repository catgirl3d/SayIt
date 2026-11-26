export type RecorderState = 'idle' | 'recording' | 'processing'
import { t } from '@/i18n'
import type { CustomWaveColors, OverlayWaveTheme } from '@/lib/overlayWaveColors'

/** Caption data the subtitle session hands to the overlay; transport shape (state, locale) belongs to OverlayService. */
export interface SubtitleOverlayPayload {
  subtitleText: string
  subtitleLiveText?: string
  subtitleLiveRecognition?: boolean
  subtitleStatus: string
  subtitleError: string
  /** Marks the caption itself (e.g. an original shown untranslated); rendered in the status line, empty hides it. */
  subtitleNotice: string
  /** Recognized original shown above the translation in dual-subtitle mode; empty in the single-caption layout. */
  subtitleSource: string
}

export type { CustomWaveColors, OverlayWaveTheme }

export type FailureRecovery = 'unknown' | 'history' | 'none'

export interface FailureOverlayPayload {
  state: 'failure'
  failureTitle: string
  failureDetail: string
  failureRecovery: FailureRecovery
  cardToken: number
}

export const OVERLAY_WIDTH_PRESET_VALUES = ['short', 'medium', 'long'] as const

export type OverlayWidthPreset = (typeof OVERLAY_WIDTH_PRESET_VALUES)[number]

export interface OverlayWidthConfig {
  barCount: number
  windowWidth: number
}

export const OVERLAY_WIDTH_PRESETS: Record<OverlayWidthPreset, OverlayWidthConfig> = {
  short: { barCount: 12, windowWidth: 200 },
  medium: { barCount: 18, windowWidth: 280 },
  long: { barCount: 24, windowWidth: 360 },
}

export function isOverlayWidthPreset(value: unknown): value is OverlayWidthPreset {
  return typeof value === 'string' && OVERLAY_WIDTH_PRESET_VALUES.includes(value as OverlayWidthPreset)
}

export interface OverlayCommonPayload {
  theme: OverlayWaveTheme
  /**
   * Custom wave colors. Sent whatever the active theme is, so every payload built by `getCommonPayload()`
   * is self-contained: the native side replaces the latest overlay payload as a whole and re-emits it
   * (`emit_latest` in window/mod.rs, e.g. after the overlay webview is recreated), so a re-emit must not
   * depend on a field that only an earlier payload carried. Subtitle payloads skip `getCommonPayload()`
   * and carry no theme; they draw no theme colors. It is three short strings, so the cost is negligible.
   */
  customWave: CustomWaveColors
  showDuration: boolean
  /**
   * Whether interface animations are enabled. Required because the overlay is a separate React
   * root and cannot read the main window's state; every common payload carries it. Subtitle
   * payloads are a separate shape and do not use the animated pill.
   */
  animationsEnabled: boolean
  /** Fixed width of the transparent overlay window; the visible pill is narrower. */
  baseWidth?: number
  /**
   * Visible width cap for the recording pill: the preset window width minus the window's 8px
   * side margin. Applied only while recording (waiting or listening); notices use the frame.
   */
  recordingWidth?: number
  barCount?: number
  /**
   * 界面语言，随每次 overlay 更新一起下发。
   *
   * 悬浮窗是**独立的 React 根**，读不到主窗的内存状态；而它必须在按下快捷键后
   * 立刻出现，不能为了读一次设置加一条异步初始化（overlay 创建本身就脆，
   * 见 pitfalls 7）。所以复用这条现成通道 —— payload 在 Rust 侧是不透明 JSON，
   * 多带一个字段是零成本的。
   */
  locale?: string
}

export interface PTTEventPayload {
  source?: string
  keycode?: number
  rawcode?: number
  altKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  reason?: string
  pttSetting?: string
  timestamp?: number
}

/**
 * 单次录音上限（秒）。到点会自动结束本次录音并进入识别。
 *
 * ⚠️ 必须与 Rust 侧 `keyboard/mod.rs` 的 HARD_RELEASE_AFTER_SECS 保持一致
 * （按住说话的硬释放在 Rust 看门狗里；免提的自动停止在 RecorderOrchestrator）。
 */
export const MAX_RECORDING_SEC = 300

/** 距上限还剩多少秒时，计时区改为显示倒计时（提醒即将到点） */
export const RECORDING_COUNTDOWN_SEC = 60

/** 上限的可读说明（如「5 分钟」/「5 min」）。界面文案一律用它，避免改了上限忘了改文案。 */
export function formatRecordingLimit(): string {
  if (MAX_RECORDING_SEC < 60) return t('duration.seconds', { count: MAX_RECORDING_SEC })
  const minutes = Math.floor(MAX_RECORDING_SEC / 60)
  const seconds = MAX_RECORDING_SEC % 60
  return seconds === 0
    ? t('duration.minutes', { count: minutes })
    : t('duration.minutesSeconds', { minutes, seconds })
}

/**
 * 悬浮窗计时区要显示的内容。
 *
 * 最后一分钟把"已录多久"换成"还剩多久"：到点会自动结束，此时用户更需要知道剩余时间。
 * 文案保持紧凑（`剩余 47s`）—— 胶囊宽度按波形条数固定，太长会被裁掉。
 */
export function formatRecordingTimer(elapsedSec: number): {
  text: string
  countdown: boolean
  remainingSec: number
} {
  const elapsed = Math.max(0, Math.floor(elapsedSec || 0))
  const remainingSec = Math.max(0, MAX_RECORDING_SEC - elapsed)
  const countdown = remainingSec <= RECORDING_COUNTDOWN_SEC
  return {
    text: countdown ? t('recording.remainingSeconds', { seconds: remainingSec }) : `${elapsed}s`,
    countdown,
    remainingSec,
  }
}
