import { describe, expect, it } from 'vitest'
import { isOverlayWidthPreset, OVERLAY_WIDTH_PRESET_VALUES, OVERLAY_WIDTH_PRESETS } from '../types'

describe('isOverlayWidthPreset', () => {
  it('accepts every declared preset and gives each one a config', () => {
    for (const preset of OVERLAY_WIDTH_PRESET_VALUES) {
      expect(isOverlayWidthPreset(preset)).toBe(true)
      expect(OVERLAY_WIDTH_PRESETS[preset]).toMatchObject({
        barCount: expect.any(Number),
        windowWidth: expect.any(Number),
      })
    }
  })

  it('rejects unknown strings, prototype keys and non-strings', () => {
    for (const bad of ['tiny', 'toString', '__proto__', '', 42, null, undefined, {}, []]) {
      expect(isOverlayWidthPreset(bad)).toBe(false)
    }
  })
})
