/**
 * Pure helper functions for RecorderOrchestrator.
 * They do not depend on `this` state and are independently testable.
 */

import type { ActiveAppContext } from '@/types/appContext'

/** Generate the id of one history record: a base36 timestamp plus a short random suffix.
 *  The suffix keeps ids distinct when two records are created within the same millisecond,
 *  because the id doubles as the record key and as the saved audio file name. */
export function createHistoryRecordId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

/** Compact AppContext for log output. */
export function summarizeAppContext(context: ActiveAppContext | null) {
  if (!context) return null
  return {
    processName: context.processName,
    exePath: context.exePath,
    windowTitle: context.windowTitle,
    windowClass: context.windowClass,
    focusClass: context.focusClass,
    controlType: context.controlType,
    focusedName: context.focusedName,
  }
}

/** Extract the appId used for stats from an AppContext. */
export function buildStatsAppId(
  appContext: ActiveAppContext | null,
  promptAppId?: string,
): string {
  const processName = String(appContext?.processName || '').trim()
  if (processName) return processName

  const exePath = String(appContext?.exePath || '').trim()
  if (exePath) {
    const segments = exePath.split(/[\\/]/).filter(Boolean)
    const lastSegment = segments[segments.length - 1]
    if (lastSegment) return lastSegment
  }

  return String(promptAppId || '').trim() || 'unknown'
}

/** Microphone level classification during recording. */
export type MicLevel = 'muted' | 'low' | 'voiced'

/** Only a strictly zero peak (an entire PCM frame of zeros) counts as "no signal".
 *  Any non-zero sample, however small, is real input: it can only be classified as quiet,
 *  never reported as "no sound detected". */
export const MIC_NO_SIGNAL_PEAK_THRESHOLD = 0
/** With a non-zero signal but RMS (0..1) below this value the input counts as
 *  "too quiet" (far from the microphone / speaking softly). */
export const MIC_LOW_RMS_THRESHOLD = 0.008

/**
 * Classify one frame by its RMS and peak:
 *  - muted : the entire PCM frame is zeros (very likely a muted mic, a wrong device, or no permission)
 *  - low   : signal is present but overall quiet (far from the microphone / speaking softly)
 *  - voiced: normal level
 * Both inputs must be normalized to 0..1 (raw int16 divided by 32768).
 */
export function classifyMicLevel(rms: number, framePeak: number): MicLevel {
  if (framePeak <= MIC_NO_SIGNAL_PEAK_THRESHOLD) return 'muted'
  if (rms < MIC_LOW_RMS_THRESHOLD) return 'low'
  return 'voiced'
}

/** After the system reports a muted endpoint, this many all-zero samples (~300 ms @ 16 kHz)
 *  must accumulate before the microphone is confirmed to be really silent.
 *  300 ms is fast enough to still feel like instant feedback, yet long enough to ride out
 *  the empty frames that can appear right after capture opens. */
export const OS_MIC_MUTE_CONFIRM_SAMPLES = 4800

/** Verdict on the "the system says the microphone is muted" clue.
 *  - wait     : still accumulating evidence; silentSamples is the updated total
 *  - confirmed: the system flag and the audio signal agree; "microphone muted" may be shown
 *  - dismissed: audio is flowing normally, the system flag does not apply; drop the clue for this recording */
export type OsMicMuteDecision =
  | { verdict: 'wait'; silentSamples: number }
  | { verdict: 'confirmed' }
  | { verdict: 'dismissed' }

/**
 * Arbitrate the system microphone-mute flag against the real audio signal.
 *
 * Why arbitration is required instead of trusting the system: `IAudioEndpointVolume::GetMute`
 * reflects the mute **setting** on the endpoint, not whether the capture stream is actually cut.
 * In practice a Plantronics Blackwire 5220 USB headset stays at GetMute=true while getUserMedia
 * keeps receiving audio at a normal level — trusting the flag would pop the red "microphone is
 * muted" high-alert on every hotkey press, only for it to clear by itself ~0.5 s later once the
 * user speaks.
 *
 * Therefore: only all-zero PCM accumulated to the threshold (both pieces of evidence agree)
 * confirms the mute; as soon as **any** non-zero sample appears, this device's mute flag does not
 * apply and the clue is dropped permanently — not reset to zero, otherwise natural pauses in
 * speech would accumulate it again.
 */
export function judgeOsMicMute(
  silentSamples: number,
  level: MicLevel,
  sampleCount: number,
): OsMicMuteDecision {
  if (level !== 'muted') return { verdict: 'dismissed' }
  const total = silentSamples + sampleCount
  if (total >= OS_MIC_MUTE_CONFIRM_SAMPLES) return { verdict: 'confirmed' }
  return { verdict: 'wait', silentSamples: total }
}

/** Whether the PTT setting contains a modifier key (both the legacy single-key
 *  and the physical-combo formats are supported). */
export function isModifierPTTSetting(pttSetting?: string): boolean {
  if (!pttSetting) return false
  return pttSetting.split('+').some((code) => (
    code.startsWith('Alt')
    || code.startsWith('Control')
    || code.startsWith('Shift')
    || code.startsWith('Meta')
  ))
}

const PROCESSING_TIMEOUT_BASE_MS = 15_000
const PROCESSING_TIMEOUT_PER_AUDIO_SEC_MS = 500
const PROCESSING_TIMEOUT_MAX_EXTRA_MS = 30_000

/** Compute the processing timeout from the audio duration and the work mode. */
export function computeProcessingTimeoutMs(
  audioDurationSec: number,
  providerMode: string,
): number {
  const safeAudioSec = Number.isFinite(audioDurationSec) ? Math.max(0, audioDurationSec) : 0
  const extraMs = Math.min(
    PROCESSING_TIMEOUT_MAX_EXTRA_MS,
    Math.ceil(safeAudioSec * PROCESSING_TIMEOUT_PER_AUDIO_SEC_MS),
  )
  let timeout = PROCESSING_TIMEOUT_BASE_MS + extraMs

  if (providerMode !== 'server') {
    timeout = Math.max(timeout, 30000)
  }
  if (providerMode === 'cloud_api') {
    const cloudTimeout = 30000 + Math.ceil(safeAudioSec * 500)
    timeout = Math.min(Math.max(timeout, cloudTimeout), 90000)
  }
  return timeout
}
