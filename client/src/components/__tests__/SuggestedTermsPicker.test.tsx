// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { t } from '@/i18n'
import SuggestedTermsPicker, { type SuggestionSet } from '../SuggestedTermsPicker'

const sets: SuggestionSet[] = [
  { key: 'code', label: 'Programming', words: ['GitHub', 'Kubernetes', 'rebase'] },
  { key: 'office', label: 'Office', words: ['Slack', 'GitLab Docs'] },
]

function renderPicker(props: Partial<Parameters<typeof SuggestedTermsPicker>[0]> = {}) {
  const onToggle = vi.fn()
  render(
    <SuggestedTermsPicker
      sets={sets}
      selected={[]}
      canAdd={() => true}
      onToggle={onToggle}
      budgetText="Budget: ~10 / 500 tokens"
      {...props}
    />,
  )
  return { onToggle }
}

describe('SuggestedTermsPicker', () => {
  afterEach(() => cleanup())

  it('shows the first set and toggles a term on click', () => {
    const { onToggle } = renderPicker()

    expect(screen.queryByRole('button', { name: 'Slack' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Kubernetes' }))
    expect(onToggle).toHaveBeenCalledWith('Kubernetes')
  })

  it('marks terms the category already has, ignoring case', () => {
    renderPicker({ selected: ['github'] })

    expect(screen.getByRole('button', { name: 'GitHub' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'rebase' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('disables terms that do not fit the budget and says why', () => {
    renderPicker({ selected: ['rebase'], canAdd: (word) => word !== 'Kubernetes' })

    expect((screen.getByRole('button', { name: 'Kubernetes' }) as HTMLButtonElement).disabled).toBe(true)
    // A selected term can always be removed, even when the budget is full.
    expect((screen.getByRole('button', { name: 'rebase' }) as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByText(t('dict.suggestedBlocked'))).toBeTruthy()
  })

  it('searches across every set', () => {
    renderPicker()

    fireEvent.change(screen.getByLabelText(t('dict.suggestedSearch')), { target: { value: 'git' } })
    expect(screen.getByRole('button', { name: 'GitHub' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'GitLab Docs' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Kubernetes' })).toBeNull()
  })

  it('switches sets with the tabs', () => {
    renderPicker()

    fireEvent.click(screen.getByRole('tab', { name: 'Office' }))
    expect(screen.getByRole('button', { name: 'Slack' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Kubernetes' })).toBeNull()
  })

  it('links the selected tab and its panel for screen readers', () => {
    renderPicker()

    const tab = screen.getByRole('tab', { name: 'Office' })
    fireEvent.click(tab)
    const panel = screen.getByRole('tabpanel', { name: 'Office' })
    expect(tab.getAttribute('aria-controls')).toBe(panel.id)
    expect(within(panel).getByRole('button', { name: 'Slack' })).toBeTruthy()
  })
})
