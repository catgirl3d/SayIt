import { describe, expect, it } from 'vitest'
import {
  buildWavePalette,
  CUSTOM_WAVE_MODES,
  DEFAULT_CUSTOM_WAVE,
  DEFAULT_WAVE_THEME,
  getWaveThinkingColor,
  getWaveTimerColor,
  needsBrightening,
  normalizeCustomWave,
  normalizeWaveTheme,
  OVERLAY_WAVE_THEMES,
  parseHexColor,
  visibleOnBlack,
  type CustomWaveColors,
  type OverlayWaveTheme,
} from '../overlayWaveColors'

/** sRGB hex to OKLab lightness. Implemented independently here instead of reusing the module under test's conversion. */
function oklabL(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
  const r = lin(((n >> 16) & 255) / 255)
  const g = lin(((n >> 8) & 255) / 255)
  const b = lin((n & 255) / 255)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
}

const HEX = /^#[0-9a-f]{6}$/

/**
 * Reference implementations, copied from the bar, timer and thinking color helpers that Overlay.tsx and
 * AppearancePage.tsx each carried before the color functions were consolidated into this module. The built-in
 * themes must keep producing exactly these values, so these formulas are intentionally duplicated here rather
 * than imported.
 */
function legacyListeningBarColor(index: number, total: number, theme: OverlayWaveTheme): string {
  const safeTotal = Math.max(1, total - 1)
  const t = index / safeTotal

  if (theme === 'black-white') {
    return '#f1f5f9'
  }

  if (theme === 'black-rainbow') {
    const hue = 140 - Math.round(t * 110)
    const lightness = 64 - Math.round(Math.abs(t - 0.5) * 12)
    return `hsl(${hue} 95% ${lightness}%)`
  }

  const hue = 190 + Math.round(t * 30)
  const lightness = 62 - Math.round(Math.abs(t - 0.5) * 14)
  return `hsl(${hue} 90% ${lightness}%)`
}

function legacyTimerColor(theme: OverlayWaveTheme): string {
  if (theme === 'black-white') return '#e5e7eb'
  if (theme === 'black-rainbow') return '#fef08a'
  return '#bae6fd'
}

function legacyThinkingColor(theme: OverlayWaveTheme): string {
  if (theme === 'black-white') return '#e2e8f0'
  if (theme === 'black-rainbow') return '#facc15'
  return '#38bdf8'
}

describe('parseHexColor', () => {
  it('normalizes to lowercase 6-digit and accepts the shorthand and a missing #', () => {
    expect(parseHexColor('#A78BFA')).toBe('#a78bfa')
    expect(parseHexColor('a78bfa')).toBe('#a78bfa')
    expect(parseHexColor('#fa0')).toBe('#ffaa00')
    expect(parseHexColor('  #123456 ')).toBe('#123456')
  })

  it('returns null for invalid input instead of guessing', () => {
    for (const bad of ['', '#12', '#12345', '#1234567', 'red', '#gggggg', null, 42, {}]) {
      expect(parseHexColor(bad)).toBeNull()
    }
  })
})

describe('normalizeCustomWave / normalizeWaveTheme', () => {
  it('falls back to the default for each bad field and keeps the good ones', () => {
    expect(normalizeCustomWave({ mode: 'solid', from: '#FF0000', to: 'nope' })).toEqual({
      mode: 'solid',
      from: '#ff0000',
      to: DEFAULT_CUSTOM_WAVE.to,
    })
    expect(normalizeCustomWave('garbage')).toEqual(DEFAULT_CUSTOM_WAVE)
    expect(normalizeCustomWave(null)).toEqual(DEFAULT_CUSTOM_WAVE)
  })

  it('accepts every declared theme', () => {
    for (const theme of OVERLAY_WAVE_THEMES) {
      expect(normalizeWaveTheme(theme)).toBe(theme)
    }
  })

  it('falls back to the app default for unknown themes', () => {
    expect(normalizeWaveTheme('neon')).toBe(DEFAULT_WAVE_THEME)
  })

  it('accepts every declared custom wave mode and falls back for unknown modes', () => {
    for (const mode of CUSTOM_WAVE_MODES) {
      expect(normalizeCustomWave({ mode, from: '#f472b6', to: '#a78bfa' }).mode).toBe(mode)
    }
    expect(normalizeCustomWave({ mode: 'neon', from: '#f472b6', to: '#a78bfa' }).mode).toBe(DEFAULT_CUSTOM_WAVE.mode)
  })
})

describe('visibility on black', () => {
  it('raises too-dark colors to the lightness floor and roughly keeps the hue', () => {
    for (const dark of ['#000000', '#000080', '#1e1b4b', '#3b0764', '#14532d']) {
      expect(needsBrightening(dark)).toBe(true)
      const fixed = visibleOnBlack(dark)
      expect(fixed).toMatch(HEX)
      expect(oklabL(fixed)).toBeGreaterThanOrEqual(0.615)
    }
    // A navy brightened this way is still blue: the blue channel is the largest
    const navy = visibleOnBlack('#000080')
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(navy.slice(i, i + 2), 16))
    expect(b).toBeGreaterThan(r)
    expect(b).toBeGreaterThan(g)
  })

  it('returns bright-enough colors unchanged, never silently altering them', () => {
    for (const bright of ['#f472b6', '#a78bfa', '#fbbf24', '#ffffff', '#22d3ee']) {
      expect(needsBrightening(bright)).toBe(false)
      expect(visibleOnBlack(bright)).toBe(bright)
    }
  })

  it('brightens a pure blue by lowering its chroma instead of clipping channels', () => {
    // Raising the lightness of #0000ff takes it outside sRGB, so the chroma is reduced until the color fits.
    // Plain channel clipping would give #1964ff, whose hue is about 1.6 degrees off.
    expect(visibleOnBlack('#0000ff')).toBe('#447cff')
  })

  it('reports brightening only when the drawn color actually changes', () => {
    // The OKLab lightness of #0086f3 is just below the floor, but 8-bit rounding maps the brightened color back to
    // the same hex. The settings hint must not promise a change that the swatch next to it does not show.
    expect(visibleOnBlack('#0086f3')).toBe('#0086f3')
    expect(needsBrightening('#0086f3')).toBe(false)
  })
})

describe('built-in themes keep their pre-consolidation colors', () => {
  const builtIn = ['black-white', 'black-blue', 'black-rainbow'] as const

  it('buildWavePalette matches the legacy bar color for every index, for 1, 2, 12, 18 and 24 bars', () => {
    for (const theme of builtIn) {
      for (const total of [1, 2, 12, 18, 24]) {
        const expected = Array.from({ length: total }, (_, index) => legacyListeningBarColor(index, total, theme))
        expect(buildWavePalette(total, theme, DEFAULT_CUSTOM_WAVE)).toEqual(expected)
      }
    }
  })

  it('getWaveTimerColor matches the legacy timer color', () => {
    for (const theme of builtIn) {
      expect(getWaveTimerColor(theme, DEFAULT_CUSTOM_WAVE)).toBe(legacyTimerColor(theme))
    }
  })

  it('getWaveThinkingColor matches the legacy thinking color', () => {
    for (const theme of builtIn) {
      expect(getWaveThinkingColor(theme, DEFAULT_CUSTOM_WAVE)).toBe(legacyThinkingColor(theme))
    }
  })
})

describe('buildWavePalette', () => {
  it('solid: every bar has the same color', () => {
    const solid: CustomWaveColors = { mode: 'solid', from: '#f472b6', to: '#000000' }
    const palette = buildWavePalette(12, 'custom', solid)
    expect(new Set(palette)).toEqual(new Set(['#f472b6']))
  })

  it('gradient: the ends are the chosen colors and every bar in between is visible on black', () => {
    const grad: CustomWaveColors = { mode: 'gradient', from: '#22d3ee', to: '#f472b6' }
    const palette = buildWavePalette(24, 'custom', grad)
    expect(palette).toHaveLength(24)
    expect(palette[0]).toBe('#22d3ee')
    expect(palette[23]).toBe('#f472b6')
    for (const c of palette) {
      expect(c).toMatch(HEX)
      expect(oklabL(c)).toBeGreaterThanOrEqual(0.615)
    }
    expect(new Set(palette).size).toBeGreaterThan(10)
  })

  it('when one end is gray, the hue is borrowed from the other end so the middle does not jump to another color', () => {
    const grad: CustomWaveColors = { mode: 'gradient', from: '#ffffff', to: '#60a5fa' }
    const palette = buildWavePalette(9, 'custom', grad)
    for (const c of palette.slice(1)) {
      const [r, , b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16))
      expect(b).toBeGreaterThanOrEqual(r)
    }
  })

  it('timer and thinking colors are derived from the custom main color and are valid colors', () => {
    const grad: CustomWaveColors = { mode: 'gradient', from: '#000080', to: '#3b0764' }
    const timer = getWaveTimerColor('custom', grad)
    const thinking = getWaveThinkingColor('custom', grad)
    expect(timer).toMatch(HEX)
    expect(thinking).toMatch(HEX)
    expect(oklabL(timer)).toBeGreaterThan(0.85)
    expect(oklabL(thinking)).toBeGreaterThanOrEqual(0.715)
  })

  it('gradient: interpolates in OKLCH along the shorter hue arc', () => {
    // Pink to lime green: the shorter arc runs through red, orange and yellow, the long one would run through blue
    // and cyan, and a mix in sRGB would give different, muddier middle colors. Pinning the whole ramp catches both
    // a lost hue wrap and a switch of the interpolation space.
    const grad: CustomWaveColors = { mode: 'gradient', from: '#f472b6', to: '#a3e635' }
    expect(buildWavePalette(9, 'custom', grad)).toEqual([
      '#f472b6', '#ff7999', '#ff8881', '#ff946a', '#ffa04b', '#fbad00', '#e7c000', '#ced300', '#a3e635',
    ])
  })

  it('timer and thinking colors keep the hue of the main color', () => {
    const emerald: CustomWaveColors = { mode: 'solid', from: '#34d399', to: '#34d399' }
    expect(getWaveTimerColor('custom', emerald)).toBe('#b5edd1')
    expect(getWaveThinkingColor('custom', emerald)).toBe('#34d399')
    const indigo: CustomWaveColors = { mode: 'solid', from: '#6366f1', to: '#6366f1' }
    expect(getWaveTimerColor('custom', indigo)).toBe('#d5dcff')
    expect(getWaveThinkingColor('custom', indigo)).toBe('#8e9aff')
  })
})
