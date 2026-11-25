/**
 * Overlay wave colors: three built-in themes plus user-defined custom colors (solid or two-color gradient).
 *
 * The overlay (overlay/Overlay.tsx) and the settings preview (AppearancePage) both take their colors from here.
 * They used to carry identical copies of the color functions, so changing one and forgetting the other made the
 * preview disagree with the real overlay.
 *
 * Custom colors have two constraints, both because the capsule background is always black:
 * 1. **Lightness has a floor** (OKLab L >= MIN_VISIBLE_L). If the user picks a dark blue or pure black, the wave is
 *    invisible on the black background and the overlay looks broken. It is better to brighten the color for them,
 *    and the preview draws the brightened result directly, so what you see is what you get.
 * 2. **Gradients are interpolated in OKLCH.** Interpolating two complementary colors in sRGB or HSL makes the middle
 *    grayish and muddy; OKLCH moves along the hue circle with perceptually uniform lightness, so a two-color gradient
 *    gets a clean transition close to the built-in rainbow.
 */

export const OVERLAY_WAVE_THEMES = ['black-white', 'black-blue', 'black-rainbow', 'custom'] as const

export type OverlayWaveTheme = (typeof OVERLAY_WAVE_THEMES)[number]

/** Theme used when no valid saved or received theme is available. */
export const DEFAULT_WAVE_THEME: OverlayWaveTheme = 'black-rainbow'

export const CUSTOM_WAVE_MODES = ['solid', 'gradient'] as const

export type CustomWaveMode = (typeof CUSTOM_WAVE_MODES)[number]

export interface CustomWaveColors {
  mode: CustomWaveMode
  /** Color in solid mode, or the gradient start (leftmost bar of the wave), #rrggbb */
  from: string
  /** Gradient end (rightmost bar), #rrggbb. Ignored in solid mode but kept, so switching back to gradient restores it */
  to: string
}

export const DEFAULT_CUSTOM_WAVE: CustomWaveColors = {
  mode: 'gradient',
  from: '#a78bfa',
  to: '#f472b6',
}

/** Recommended colors. Solid presets are a row of swatches; gradient presets are start/end pairs, applied with one click. */
export const SOLID_WAVE_PRESETS: readonly string[] = [
  '#f472b6', '#a78bfa', '#60a5fa', '#2dd4bf', '#34d399', '#a3e635', '#fbbf24', '#f87171',
]

export const GRADIENT_WAVE_PRESETS: ReadonlyArray<readonly [string, string]> = [
  ['#a78bfa', '#f472b6'],
  ['#60a5fa', '#c084fc'],
  ['#22d3ee', '#a3e635'],
  ['#2dd4bf', '#818cf8'],
  ['#fbbf24', '#f472b6'],
  ['#fb923c', '#f43f5e'],
]

/**
 * Minimum OKLab lightness that stays recognizable on the black background. 0.62 corresponds to a relative luminance
 * of about 0.24 (neutral gray), a contrast ratio of about 5.8:1 against pure black. Most bars of the built-in themes sit
 * above this (the darkest, the blue end of black-blue, is slightly below it); the floor only catches colors that would
 * actually disappear and leaves medium-brightness colors the user picked unchanged.
 */
export const MIN_VISIBLE_L = 0.62

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i

/**
 * Normalizes user input to lowercase #rrggbb; returns null for anything that is not a valid color.
 * Accepts the 3-digit shorthand and an omitted #.
 */
export function parseHexColor(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const m = HEX_RE.exec(input.trim())
  if (!m) return null
  let hex = m[1].toLowerCase()
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('')
  return `#${hex}`
}

function isOverlayWaveTheme(value: unknown): value is OverlayWaveTheme {
  return typeof value === 'string' && OVERLAY_WAVE_THEMES.includes(value as OverlayWaveTheme)
}

function isCustomWaveMode(value: unknown): value is CustomWaveMode {
  return typeof value === 'string' && CUSTOM_WAVE_MODES.includes(value as CustomWaveMode)
}

export function normalizeWaveTheme(value: unknown): OverlayWaveTheme {
  return isOverlayWaveTheme(value) ? value : DEFAULT_WAVE_THEME
}

/**
 * Values read back from settings, backups or payloads are untrusted, so every field is validated on its own and
 * bad fields fall back to the defaults.
 */
export function normalizeCustomWave(value: unknown): CustomWaveColors {
  const raw = (value && typeof value === 'object') ? value as Record<string, unknown> : {}
  return {
    mode: isCustomWaveMode(raw.mode) ? raw.mode : DEFAULT_CUSTOM_WAVE.mode,
    from: parseHexColor(raw.from) ?? DEFAULT_CUSTOM_WAVE.from,
    to: parseHexColor(raw.to) ?? DEFAULT_CUSTOM_WAVE.to,
  }
}

export function sameCustomWave(a: CustomWaveColors, b: CustomWaveColors): boolean {
  return a.mode === b.mode && a.from === b.from && a.to === b.to
}

// ── OKLab / OKLCH (formulas by Björn Ottosson) ──────────────────────────

interface Lch { l: number; c: number; h: number }

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
}

function hexToLch(hex: string): Lch {
  const n = parseInt(hex.slice(1), 16)
  const r = srgbToLinear(((n >> 16) & 255) / 255)
  const g = srgbToLinear(((n >> 8) & 255) / 255)
  const b = srgbToLinear((n & 255) / 255)
  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_
  const A = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
  const h = (Math.atan2(B, A) * 180) / Math.PI
  return { l: L, c: Math.hypot(A, B), h: h < 0 ? h + 360 : h }
}

/**
 * OKLCH to sRGB channels after gamma encoding. Values may fall outside [0, 1]; an out-of-range value means the
 * color cannot be represented in sRGB.
 */
function lchToRgb({ l, c, h }: Lch): [number, number, number] {
  const rad = (h * Math.PI) / 180
  const A = c * Math.cos(rad)
  const B = c * Math.sin(rad)
  const l_ = l + 0.3963377774 * A + 0.2158037573 * B
  const m_ = l - 0.1055613458 * A - 0.0638541728 * B
  const s_ = l - 0.0894841775 * A - 1.2914855480 * B
  const L3 = l_ * l_ * l_
  const M3 = m_ * m_ * m_
  const S3 = s_ * s_ * s_
  return [
    linearToSrgb(4.0767416621 * L3 - 3.3077115913 * M3 + 0.2309699292 * S3),
    linearToSrgb(-1.2684380046 * L3 + 2.6097574011 * M3 - 0.3413193965 * S3),
    linearToSrgb(-0.0041960863 * L3 - 0.7034186147 * M3 + 1.7076147010 * S3),
  ]
}

function inGamut(rgb: [number, number, number]): boolean {
  return rgb.every((v) => v >= -0.0005 && v <= 1.0005)
}

/**
 * Converts back to hex. After raising lightness, the original chroma often falls outside sRGB (for example a pure
 * blue brightened up). Clipping the channels directly would shift the hue, so lightness and hue are kept and chroma
 * is bisected down until the color fits inside the gamut.
 */
function lchToHex(lch: Lch): string {
  let rgb = lchToRgb(lch)
  if (!inGamut(rgb)) {
    let lo = 0
    let hi = lch.c
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2
      if (inGamut(lchToRgb({ ...lch, c: mid }))) lo = mid
      else hi = mid
    }
    rgb = lchToRgb({ ...lch, c: lo })
  }
  return `#${rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`
}

function withVisibleLightness(lch: Lch): Lch {
  return lch.l >= MIN_VISIBLE_L ? lch : { ...lch, l: MIN_VISIBLE_L }
}

/**
 * Whether this color would be changed on the black capsule (the settings page uses this to show a hint).
 * It compares the drawn result rather than the lightness alone: a color just below the floor can round back to the same
 * 8-bit hex after brightening, and the hint must not promise a change the swatch next to it does not show.
 */
export function needsBrightening(hex: string): boolean {
  const parsed = parseHexColor(hex)
  return parsed !== null && visibleOnBlack(parsed) !== parsed
}

/** The color actually drawn on the black background: colors bright enough are returned unchanged, darker ones are raised to the lightness floor. */
export function visibleOnBlack(hex: string): string {
  const parsed = parseHexColor(hex) ?? DEFAULT_CUSTOM_WAVE.from
  const lch = hexToLch(parsed)
  return lch.l < MIN_VISIBLE_L ? lchToHex(withVisibleLightness(lch)) : parsed
}

/**
 * Hue is meaningless for near-gray colors (atan2 returns noise there), so when interpolating, such a color borrows
 * the hue of the other end. This keeps the middle of the gradient from jumping to an unrelated color.
 */
const ACHROMATIC_C = 0.02

function mixLch(a: Lch, b: Lch, t: number): Lch {
  let ha = a.h
  let hb = b.h
  if (a.c < ACHROMATIC_C) ha = hb
  if (b.c < ACHROMATIC_C) hb = ha
  // Take the shorter arc of the hue circle: violet to pink should pass through magenta, not loop the long way through green
  let dh = hb - ha
  if (dh > 180) dh -= 360
  if (dh < -180) dh += 360
  const h = ha + dh * t
  return {
    l: a.l + (b.l - a.l) * t,
    c: a.c + (b.c - a.c) * t,
    h: h < 0 ? h + 360 : h % 360,
  }
}

/** Custom color at position t (0 = leftmost, 1 = rightmost), guaranteed to be visible on black. */
function customColorAt(custom: CustomWaveColors, t: number): string {
  const from = hexToLch(parseHexColor(custom.from) ?? DEFAULT_CUSTOM_WAVE.from)
  if (custom.mode === 'solid') return lchToHex(withVisibleLightness(from))
  const to = hexToLch(parseHexColor(custom.to) ?? DEFAULT_CUSTOM_WAVE.to)
  return lchToHex(withVisibleLightness(mixLch(from, to, t)))
}

function assertNever(value: never): never {
  throw new Error(`Unhandled overlay wave theme: ${value}`)
}

// ── Public color functions ──────────────────────────────────────────────

/**
 * Colors for the whole wave, bar by bar from left to right.
 *
 * The full palette is computed at once rather than per bar: while recording, the overlay re-renders about 30 times
 * per second with two dozen bars per frame, and custom colors go through OKLCH conversion and gamut reduction.
 * The callers that run on every frame (the overlay and the settings preview) wrap the call in useMemo so it only
 * recomputes when the colors or the bar count change.
 */
export function buildWavePalette(total: number, theme: OverlayWaveTheme, custom: CustomWaveColors): string[] {
  const count = Math.max(0, Math.floor(total))
  const denom = Math.max(1, count - 1)
  return Array.from({ length: count }, (_, index) => {
    const t = index / denom
    switch (theme) {
      case 'black-white':
        return '#f1f5f9'
      case 'black-blue': {
        const hue = 190 + Math.round(t * 30)
        const lightness = 62 - Math.round(Math.abs(t - 0.5) * 14)
        return `hsl(${hue} 90% ${lightness}%)`
      }
      case 'black-rainbow': {
        const hue = 140 - Math.round(t * 110)
        const lightness = 64 - Math.round(Math.abs(t - 0.5) * 12)
        return `hsl(${hue} 95% ${lightness}%)`
      }
      case 'custom':
        return customColorAt(custom, t)
      default:
        return assertNever(theme)
    }
  })
}

// Keep custom timer digits bright enough to read on the black capsule.
const WAVE_TIMER_MIN_LIGHTNESS = 0.9
// Reduce chroma so the derived timer color remains a pale accent.
const WAVE_TIMER_CHROMA_SCALE = 0.45

/**
 * Color of the timer digits. Custom colors do not let the user pick this separately: it is derived from the main
 * color as a lighter, paler version, matching the built-in themes (the blue theme's timer is the pale sky blue
 * #bae6fd). Fewer options also make it harder to end up with an ugly combination.
 */
export function getWaveTimerColor(theme: OverlayWaveTheme, custom: CustomWaveColors): string {
  switch (theme) {
    case 'black-white':
      return '#e5e7eb'
    case 'black-blue':
      return '#bae6fd'
    case 'black-rainbow':
      return '#fef08a'
    case 'custom': {
      const base = hexToLch(customColorAt(custom, 0.5))
      return lchToHex({ l: Math.max(base.l, WAVE_TIMER_MIN_LIGHTNESS), c: base.c * WAVE_TIMER_CHROMA_SCALE, h: base.h })
    }
    default:
      return assertNever(theme)
  }
}

// Keep custom thinking colors visible without changing already-bright colors.
const WAVE_THINKING_MIN_LIGHTNESS = 0.72

/** Color of the "recognizing" (thinking) animation: taken from the middle of the main color, with lightness raised to at least 0.72 so it stands out on black (a color already brighter than that is used as is). */
export function getWaveThinkingColor(theme: OverlayWaveTheme, custom: CustomWaveColors): string {
  switch (theme) {
    case 'black-white':
      return '#e2e8f0'
    case 'black-blue':
      return '#38bdf8'
    case 'black-rainbow':
      return '#facc15'
    case 'custom': {
      const base = hexToLch(customColorAt(custom, 0.5))
      return lchToHex({ ...base, l: Math.max(base.l, WAVE_THINKING_MIN_LIGHTNESS) })
    }
    default:
      return assertNever(theme)
  }
}
