import { describe, expect, it } from 'vitest'
import { DEFAULT_MIC_BOOST, MIC_BOOST_VALUES, resolveMicBoost } from '../defaults'

describe('microphone boost settings', () => {
  it('keeps the documented string values and fixed gains', () => {
    expect(MIC_BOOST_VALUES).toEqual(['1', '2', '3', '5', 'auto'])
    expect(resolveMicBoost('1')).toEqual({ setting: '1', gain: 1, autoGainControl: false })
    expect(resolveMicBoost('2')).toEqual({ setting: '2', gain: 2, autoGainControl: false })
    expect(resolveMicBoost('3')).toEqual({ setting: '3', gain: 3, autoGainControl: false })
    expect(resolveMicBoost('5')).toEqual({ setting: '5', gain: 5, autoGainControl: false })
  })

  it('delegates auto mode to browser gain control without fixed gain', () => {
    expect(resolveMicBoost('auto')).toEqual({ setting: 'auto', gain: 1, autoGainControl: true })
  })

  it('falls back to the default for invalid or non-string values', () => {
    expect(resolveMicBoost('invalid')).toEqual(resolveMicBoost(DEFAULT_MIC_BOOST))
    expect(resolveMicBoost(3)).toEqual(resolveMicBoost(DEFAULT_MIC_BOOST))
    expect(resolveMicBoost(false)).toEqual(resolveMicBoost(DEFAULT_MIC_BOOST))
  })
})
