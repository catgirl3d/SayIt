// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { t } from '@/i18n'
import { getTheme, themeList } from '@/themes'
import { ThemePicker } from '../ThemePicker'

function names(ids: string[]) {
  return ids.map((id) => getTheme(id).name)
}

function renderPicker(value: string) {
  const onChange = vi.fn()
  const view = render(<ThemePicker themes={themeList} value={value} onChange={onChange} label="App theme" />)
  return { onChange, ...view }
}

function tiles() {
  return within(screen.getByRole('radiogroup', { name: 'App theme' })).getAllByRole('radio')
}

describe('ThemePicker', () => {
  it('lists only the themes of the active theme brightness', () => {
    renderPicker('teal-dark')

    expect(tiles().map((tile) => tile.textContent)).toEqual(
      names(['dark', 'teal-dark', 'twilight', 'espresso', 'midnight']),
    )
  })

  it('marks only the active theme as checked', () => {
    renderPicker('teal-dark')

    const checked = tiles().filter((tile) => tile.getAttribute('aria-checked') === 'true')
    expect(checked.map((tile) => tile.textContent)).toEqual(names(['teal-dark']))
  })

  it('shows the light group for a light active theme', () => {
    renderPicker('frost')

    expect(tiles().map((tile) => tile.textContent)).toEqual(
      names(['light', 'claude', 'teal', 'orchid', 'frost', 'moss']),
    )
  })

  it('lists the other group when the filter is switched, without changing the theme', () => {
    const { onChange } = renderPicker('teal-dark')

    fireEvent.click(screen.getByRole('radio', { name: t('appearance.themeLight') }))

    expect(tiles().map((tile) => tile.textContent)).toEqual(
      names(['light', 'claude', 'teal', 'orchid', 'frost', 'moss']),
    )
    expect(tiles().some((tile) => tile.getAttribute('aria-checked') === 'true')).toBe(false)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('reports the clicked theme id', () => {
    const { onChange } = renderPicker('teal-dark')

    fireEvent.click(screen.getByRole('radio', { name: getTheme('midnight').name }))

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('midnight')
  })

  it('reports a theme picked from the other group', () => {
    const { onChange } = renderPicker('teal-dark')

    fireEvent.click(screen.getByRole('radio', { name: t('appearance.themeLight') }))
    fireEvent.click(screen.getByRole('radio', { name: getTheme('frost').name }))

    expect(onChange).toHaveBeenCalledWith('frost')
  })

  it('follows the active theme after the parent applies a pick from the other group', () => {
    const { rerender } = renderPicker('teal-dark')

    fireEvent.click(screen.getByRole('radio', { name: t('appearance.themeLight') }))
    fireEvent.click(screen.getByRole('radio', { name: getTheme('frost').name }))
    rerender(<ThemePicker themes={themeList} value="frost" onChange={vi.fn()} label="App theme" />)

    const checked = tiles().filter((tile) => tile.getAttribute('aria-checked') === 'true')
    expect(checked.map((tile) => tile.textContent)).toEqual(names(['frost']))
    expect(
      screen.getByRole('radio', { name: t('appearance.themeLight') }).getAttribute('aria-checked'),
    ).toBe('true')
  })
})
