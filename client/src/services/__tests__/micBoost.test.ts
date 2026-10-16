import { describe, expect, it } from 'vitest'
import { DEFAULT_MIC_BOOST, MIC_BOOST_MAX, MIC_BOOST_MIN, resolveMicBoost } from '../defaults'

describe('microphone boost settings', () => {
  it('keeps every value saved by the old fixed-step picker at the same gain', () => {
    expect(resolveMicBoost('1')).toEqual({ setting: '1', gain: 1, autoGainControl: false })
    expect(resolveMicBoost('2')).toEqual({ setting: '2', gain: 2, autoGainControl: false })
    expect(resolveMicBoost('3')).toEqual({ setting: '3', gain: 3, autoGainControl: false })
    expect(resolveMicBoost('5')).toEqual({ setting: '5', gain: 5, autoGainControl: false })
  })

  it('accepts fixed gains above the old 5x ceiling', () => {
    expect(resolveMicBoost('7.5')).toEqual({ setting: '7.5', gain: 7.5, autoGainControl: false })
    expect(resolveMicBoost('12')).toEqual({ setting: '12', gain: 12, autoGainControl: false })
    expect(resolveMicBoost(String(MIC_BOOST_MAX))).toEqual({
      setting: String(MIC_BOOST_MAX),
      gain: MIC_BOOST_MAX,
      autoGainControl: false,
    })
  })

  it('clamps gains outside the supported range', () => {
    expect(resolveMicBoost('0')).toMatchObject({ setting: String(MIC_BOOST_MIN), gain: MIC_BOOST_MIN })
    expect(resolveMicBoost('0.5')).toMatchObject({ setting: String(MIC_BOOST_MIN), gain: MIC_BOOST_MIN })
    expect(resolveMicBoost('21')).toMatchObject({ setting: String(MIC_BOOST_MAX), gain: MIC_BOOST_MAX })
    expect(resolveMicBoost('9'.repeat(400))).toMatchObject({ setting: String(MIC_BOOST_MAX), gain: MIC_BOOST_MAX })
  })

  it('snaps gains to the slider step and stores a canonical string', () => {
    expect(resolveMicBoost('4.2')).toMatchObject({ setting: '4', gain: 4 })
    expect(resolveMicBoost('4.3')).toMatchObject({ setting: '4.5', gain: 4.5 })
    expect(resolveMicBoost('3.0')).toMatchObject({ setting: '3', gain: 3 })
    expect(resolveMicBoost('03')).toMatchObject({ setting: '3', gain: 3 })
  })

  it('delegates auto mode to browser gain control without fixed gain', () => {
    expect(resolveMicBoost('auto')).toEqual({ setting: 'auto', gain: 1, autoGainControl: true })
  })

  it('falls back to the default for invalid or non-string values', () => {
    const fallback = resolveMicBoost(DEFAULT_MIC_BOOST)
    for (const value of ['invalid', '', ' ', '-2', '1e1', '0x10', 'NaN', 'Infinity', '5x', 3, false, null, undefined]) {
      expect(resolveMicBoost(value)).toEqual(fallback)
    }
  })
})
