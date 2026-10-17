import { describe, expect, it } from 'vitest'
import { getTheme, themeList } from '@/themes'

describe('theme registry', () => {
  it('exposes the teal themes in the selectable theme list', () => {
    expect(themeList.map((theme) => theme.id)).toEqual([
      'light',
      'dark',
      'claude',
      'teal',
      'teal-dark',
    ])
  })

  it('resolves teal theme IDs without falling back to light', () => {
    expect(getTheme('teal').id).toBe('teal')
    expect(getTheme('teal-dark').id).toBe('teal-dark')
  })
})
