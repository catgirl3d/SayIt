import { describe, expect, it } from 'vitest'
import { MIC_BOOST_MAX, MIC_BOOST_MIN, MIC_BOOST_STEP } from '@/services/defaults'
import {
  MIC_BOOST_HIGH_ABOVE,
  MIC_BOOST_POSITION_MAX,
  MIC_BOOST_PRESETS,
  MIC_BOOST_RISK_ABOVE,
  micBoostDecibels,
  micBoostForKey,
  micBoostToPosition,
  micBoostZone,
  positionToMicBoost,
} from '../micBoostScale'

const SUPPORTED_GAINS = Array.from(
  { length: (MIC_BOOST_MAX - MIC_BOOST_MIN) / MIC_BOOST_STEP + 1 },
  (_, index) => MIC_BOOST_MIN + index * MIC_BOOST_STEP,
)

describe('microphone boost slider scale', () => {
  it('spans the whole track from the minimum to the maximum gain', () => {
    expect(micBoostToPosition(MIC_BOOST_MIN)).toBe(0)
    expect(micBoostToPosition(MIC_BOOST_MAX)).toBeCloseTo(1, 10)
    expect(positionToMicBoost(0)).toBe(MIC_BOOST_MIN)
    expect(positionToMicBoost(1)).toBe(MIC_BOOST_MAX)
  })

  it('gives every doubling the same width', () => {
    const doubling = micBoostToPosition(2) - micBoostToPosition(1)
    expect(micBoostToPosition(4) - micBoostToPosition(2)).toBeCloseTo(doubling, 10)
    expect(micBoostToPosition(8) - micBoostToPosition(4)).toBeCloseTo(doubling, 10)
    expect(micBoostToPosition(16) - micBoostToPosition(8)).toBeCloseTo(doubling, 10)
  })

  it('moves strictly forward with the gain', () => {
    const positions = SUPPORTED_GAINS.map(micBoostToPosition)
    for (let index = 1; index < positions.length; index++) {
      expect(positions[index]).toBeGreaterThan(positions[index - 1])
    }
  })

  it('returns every supported gain from its quantized slider position', () => {
    for (const gain of SUPPORTED_GAINS) {
      const quantized = Math.round(micBoostToPosition(gain) * MIC_BOOST_POSITION_MAX) / MIC_BOOST_POSITION_MAX
      expect(positionToMicBoost(quantized)).toBe(gain)
    }
  })

  it('clamps positions outside the track', () => {
    expect(positionToMicBoost(-0.5)).toBe(MIC_BOOST_MIN)
    expect(positionToMicBoost(1.5)).toBe(MIC_BOOST_MAX)
  })

  it('offers presets that are supported gains', () => {
    for (const preset of MIC_BOOST_PRESETS) {
      expect(SUPPORTED_GAINS).toContain(preset)
    }
    expect(MIC_BOOST_PRESETS[0]).toBe(MIC_BOOST_MIN)
    expect(MIC_BOOST_PRESETS[MIC_BOOST_PRESETS.length - 1]).toBe(MIC_BOOST_MAX)
  })

  it('switches zones just above the boundaries', () => {
    expect(micBoostZone(MIC_BOOST_MIN)).toBe('safe')
    expect(micBoostZone(MIC_BOOST_HIGH_ABOVE)).toBe('safe')
    expect(micBoostZone(MIC_BOOST_HIGH_ABOVE + MIC_BOOST_STEP)).toBe('high')
    expect(micBoostZone(MIC_BOOST_RISK_ABOVE)).toBe('high')
    expect(micBoostZone(MIC_BOOST_RISK_ABOVE + MIC_BOOST_STEP)).toBe('risk')
    expect(micBoostZone(MIC_BOOST_MAX)).toBe('risk')
  })

  it('converts gain to whole decibels', () => {
    expect(micBoostDecibels(1)).toBe(0)
    expect(micBoostDecibels(2)).toBe(6)
    expect(micBoostDecibels(10)).toBe(20)
    expect(micBoostDecibels(20)).toBe(26)
  })

  it('steps the gain from the keyboard and stays inside the range', () => {
    expect(micBoostForKey('ArrowRight', 3)).toBe(3.5)
    expect(micBoostForKey('ArrowUp', 3)).toBe(3.5)
    expect(micBoostForKey('ArrowLeft', 3)).toBe(2.5)
    expect(micBoostForKey('ArrowDown', 3)).toBe(2.5)
    expect(micBoostForKey('PageUp', 3)).toBe(5)
    expect(micBoostForKey('PageDown', 3)).toBe(1)
    expect(micBoostForKey('Home', 7)).toBe(MIC_BOOST_MIN)
    expect(micBoostForKey('End', 7)).toBe(MIC_BOOST_MAX)
    expect(micBoostForKey('ArrowLeft', MIC_BOOST_MIN)).toBe(MIC_BOOST_MIN)
    expect(micBoostForKey('ArrowRight', MIC_BOOST_MAX)).toBe(MIC_BOOST_MAX)
    expect(micBoostForKey('PageUp', 19)).toBe(MIC_BOOST_MAX)
  })

  it('ignores keys the slider does not handle', () => {
    expect(micBoostForKey('Tab', 3)).toBeNull()
    expect(micBoostForKey('Enter', 3)).toBeNull()
    expect(micBoostForKey('a', 3)).toBeNull()
  })
})
