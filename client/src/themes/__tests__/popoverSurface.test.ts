import { describe, expect, it } from 'vitest'
import { themeList } from '@/themes'

function hslLightness(value: string): number {
  const lightness = value.trim().split(/\s+/)[2] ?? ''
  expect(lightness).toMatch(/%$/)
  return Number.parseFloat(lightness)
}

describe('floating surfaces', () => {
  it('defines a popover surface in every theme', () => {
    for (const theme of themeList) {
      expect(theme.vars['--popover'], theme.id).toMatch(/\d+%$/)
    }
  })

  it('keeps popover surfaces darker than cards and page background in dark themes', () => {
    const darkThemes = themeList.filter((theme) => theme.isDark)
    expect(darkThemes.length).toBeGreaterThan(0)

    for (const theme of darkThemes) {
      const popover = hslLightness(theme.vars['--popover'])
      expect(popover, theme.id).toBeLessThan(hslLightness(theme.vars['--card']))
      expect(popover, theme.id).toBeLessThan(hslLightness(theme.vars['--background']))
    }
  })
})
