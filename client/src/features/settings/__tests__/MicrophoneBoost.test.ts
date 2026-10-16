import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import MicrophoneSection from '../MicrophoneSection'
import type { MicBoostSetting } from '@/services/defaults'

vi.mock('@/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/i18n')>()),
  getLocale: () => 'en',
}))

vi.mock('@/i18n/useT', () => ({
  useT: () => (key: string, params?: Record<string, string | number>) =>
    params ? `${key}(${Object.values(params).join(', ')})` : key,
}))

function renderBoost(micBoost: MicBoostSetting): string {
  return renderToStaticMarkup(createElement(MicrophoneSection, {
    mics: [],
    selectedMic: '',
    testing: false,
    volumeLevel: 'idle',
    micBoost,
    ready: true,
    animate: false,
    onCanvasRef: () => {},
    onMicChange: () => {},
    onTestMic: () => {},
    onMicBoostChange: () => {},
  }))
}

describe('Microphone boost control', () => {
  it('offers a range input named by the section title', () => {
    const markup = renderBoost('3')

    expect(markup).toContain('type="range"')
    expect(markup).toContain('aria-labelledby="mic-boost-label"')
  })

  it('places the thumb on the logarithmic track and announces value, decibels and zone', () => {
    const markup = renderBoost('10')

    // ln(10) / ln(20) of the 0..1000 track.
    expect(markup).toContain('value="769"')
    expect(markup).toContain('aria-valuetext="mic.boostValue(10), mic.boostDecibels(+20), mic.boostZoneHigh"')
  })

  it('shows and announces a saved gain above 10x as a distortion risk', () => {
    const markup = renderBoost('12.5')

    expect(markup).toContain('aria-valuetext="mic.boostValue(12.5), mic.boostDecibels(+22), mic.boostZoneRisk"')
  })

  it('names only the current zone below the track', () => {
    const safe = renderBoost('3')

    expect(safe).toContain('mic.boostZoneSafe')
    expect(safe).not.toContain('mic.boostZoneHigh')
    expect(safe).not.toContain('mic.boostZoneRisk')
    expect(renderBoost('12.5')).toContain('mic.boostZoneRisk')
  })

  it('offers one preset chip per preset and marks the active one', () => {
    const markup = renderBoost('5')

    for (const preset of [1, 2, 3, 5, 10, 20]) {
      expect(markup).toContain(`>mic.boostValue(${preset})</button>`)
    }
    expect(markup.match(/aria-pressed="true"/g)).toHaveLength(1)
    expect(markup).toMatch(/aria-pressed="true"[^>]*>mic\.boostValue\(5\)<\/button>/)
    expect(markup).toContain('title="mic.boostOffTitle"')
  })

  it('marks no chip as active for a gain between presets', () => {
    expect(renderBoost('7.5').match(/aria-pressed="true"/g)).toBeNull()
  })

  it('places the preset chips above the slider', () => {
    const markup = renderBoost('3')

    expect(markup.indexOf('mic.boostValue(1)')).toBeLessThan(markup.indexOf('type="range"'))
  })

  it('replaces the control with an explanation in auto mode', () => {
    const markup = renderBoost('auto')

    expect(markup).not.toContain('type="range"')
    expect(markup).not.toContain('aria-pressed')
    expect(markup).toContain('mic.boostAutoDesc')
    expect(markup).toContain('mic.boostAuto')
    expect(markup).toContain('mic.boostManual')
  })
})
