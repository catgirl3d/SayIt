import { describe, expect, it } from 'vitest'
import { getTheme, themeList } from '@/themes'

describe('theme registry', () => {
  it('exposes every bundled theme in the selectable theme list', () => {
    expect(themeList.map((theme) => theme.id)).toEqual([
      'light',
      'dark',
      'claude',
      'teal',
      'teal-dark',
      'orchid',
      'twilight',
      'espresso',
      'frost',
      'moss',
      'midnight',
    ])
  })

  it('resolves the colour theme IDs without falling back to light', () => {
    for (const id of ['teal', 'teal-dark', 'orchid', 'twilight', 'espresso', 'frost', 'moss', 'midnight']) {
      expect(getTheme(id).id).toBe(id)
    }
  })

  it('splits the registry into a light and a dark group that together cover every theme', () => {
    const light = themeList.filter((theme) => !theme.isDark)
    const dark = themeList.filter((theme) => theme.isDark)
    expect(light.map((theme) => theme.id)).toEqual(['light', 'claude', 'teal', 'orchid', 'frost', 'moss'])
    expect(dark.map((theme) => theme.id)).toEqual(['dark', 'teal-dark', 'twilight', 'espresso', 'midnight'])
  })
})
