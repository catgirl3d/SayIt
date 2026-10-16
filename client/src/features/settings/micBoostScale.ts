import { MIC_BOOST_MAX, MIC_BOOST_MIN, MIC_BOOST_STEP, normalizeMicBoostGain } from '@/services/defaults'

// Presentation of the microphone boost slider. Gain is perceived roughly logarithmically
// (every doubling is +6 dB), so the slider position follows a logarithmic scale: with a
// linear track the everyday 1x-5x range would take only about a fifth of the width.

/** Gains above this make background noise noticeably louder. A heuristic, not a measured limit. */
export const MIC_BOOST_HIGH_ABOVE = 5
/** Gains above this start to distort loud speech. A heuristic, not a measured limit. */
export const MIC_BOOST_RISK_ABOVE = 10
export const MIC_BOOST_PRESETS = [1, 2, 3, 5, 10, 20] as const
/** The native range input works in 0..1000 positions; the gain is snapped to the step afterwards. */
export const MIC_BOOST_POSITION_MAX = 1000

/** Arrow keys move one step; PageUp/PageDown move four steps. */
const PAGE_STEPS = 4

export type MicBoostZone = 'safe' | 'high' | 'risk'

const LOG_SPAN = Math.log(MIC_BOOST_MAX / MIC_BOOST_MIN)

/** Position of a gain on the logarithmic track, from 0 (minimum) to 1 (maximum). */
export function micBoostToPosition(gain: number): number {
  return Math.log(gain / MIC_BOOST_MIN) / LOG_SPAN
}

/** Inverse of {@link micBoostToPosition}; the result is clamped and snapped to the supported gains. */
export function positionToMicBoost(position: number): number {
  const clamped = Math.min(1, Math.max(0, position))
  return normalizeMicBoostGain(MIC_BOOST_MIN * Math.exp(clamped * LOG_SPAN))
}

export function micBoostZone(gain: number): MicBoostZone {
  if (gain > MIC_BOOST_RISK_ABOVE) return 'risk'
  if (gain > MIC_BOOST_HIGH_ABOVE) return 'high'
  return 'safe'
}

/** Whole decibels: 2x is about +6 dB, 10x is +20 dB. */
export function micBoostDecibels(gain: number): number {
  return Math.round(20 * Math.log10(gain))
}

/**
 * Gain requested by a slider key, or null for keys the slider does not handle. The native range
 * input would move by one thousandth of the logarithmic track, which snaps back to the same gain,
 * so keyboard control works in gain steps instead.
 */
export function micBoostForKey(key: string, gain: number): number | null {
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      return normalizeMicBoostGain(gain - MIC_BOOST_STEP)
    case 'ArrowRight':
    case 'ArrowUp':
      return normalizeMicBoostGain(gain + MIC_BOOST_STEP)
    case 'PageDown':
      return normalizeMicBoostGain(gain - MIC_BOOST_STEP * PAGE_STEPS)
    case 'PageUp':
      return normalizeMicBoostGain(gain + MIC_BOOST_STEP * PAGE_STEPS)
    case 'Home':
      return MIC_BOOST_MIN
    case 'End':
      return MIC_BOOST_MAX
    default:
      return null
  }
}
