// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { t } from '@/i18n'
import { ModelPicker, formatUsd, priceBadge, type ModelPickerProps } from '../ModelPicker'
import type { RemoteModel } from '../aiProviderCatalog'

function renderPicker(models: RemoteModel[], props: Partial<ModelPickerProps> = {}) {
  const onChange = vi.fn()
  render(
    <ModelPicker
      models={models}
      value={props.value ?? ''}
      onChange={onChange}
      placeholder="Pick a model"
    />,
  )
  const trigger = screen.getByRole('button', { name: /Pick a model/ })
  fireEvent.click(trigger)
  return { onChange, trigger }
}

/** Which of the candidate texts (row display names) appear in each visible row, in row order. */
function visibleNames(candidates: string[]): (string | undefined)[] {
  return screen.getAllByRole('option').map((row) =>
    candidates.find((candidate) => within(row).queryAllByText(candidate).length > 0),
  )
}

function rowByName(name: string): HTMLElement {
  const row = screen.getAllByRole('option').find((option) => within(option).queryAllByText(name).length > 0)
  if (!row) throw new Error(`row "${name}" not found`)
  return row
}

describe('formatUsd', () => {
  it('formats per-million prices without exponent notation', () => {
    expect(formatUsd(0)).toBe('$0.00/M')
    expect(formatUsd(0.15)).toBe('$0.15/M')
    expect(formatUsd(25)).toBe('$25.00/M')
    expect(formatUsd(0.003)).toBe('$0.003/M')
  })
})

describe('priceBadge', () => {
  it('reports no badge for an unknown input price, free only for two zeros, price otherwise', () => {
    expect(priceBadge({ id: 'm' })).toEqual({ kind: 'none' })
    expect(priceBadge({ id: 'm', input_price_per_million: 0 })).toEqual({ kind: 'price', text: '$0.00/M' })
    expect(priceBadge({ id: 'm', input_price_per_million: 0, output_price_per_million: 0 })).toEqual({ kind: 'free' })
    expect(priceBadge({ id: 'm', input_price_per_million: 0.15, output_price_per_million: 0.6 }))
      .toEqual({ kind: 'price', text: '$0.15/M' })
  })
})

describe('ModelPicker search', () => {
  it('filters case-insensitively by display name and by id, trimming the query', () => {
    renderPicker([
      { id: 'vendor/alpha', name: 'Friendly Alpha' },
      { id: 'beta-id', name: 'Unrelated Name' },
    ])
    const search = screen.getByLabelText(t('ai.modelSearch'))

    fireEvent.change(search, { target: { value: '  FRIENDLY  ' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByText('Friendly Alpha')).toBeTruthy()

    fireEvent.change(search, { target: { value: 'BETA-ID' } })
    const rows = screen.getAllByRole('option')
    expect(rows).toHaveLength(1)
    expect(within(rows[0]).getByText('Unrelated Name')).toBeTruthy()
    expect(screen.queryByText('Friendly Alpha')).toBeNull()
  })

  it('shows a no-match message when nothing matches', () => {
    renderPicker([{ id: 'vendor/alpha', name: 'Friendly Alpha' }])
    fireEvent.change(screen.getByLabelText(t('ai.modelSearch')), { target: { value: 'zzz' } })

    expect(screen.getByText(t('ai.modelNoMatch'))).toBeTruthy()
    expect(screen.queryAllByRole('option')).toHaveLength(0)
  })
})

describe('ModelPicker sorting', () => {
  const candidates = ['FreeOne', 'Another', 'One', 'Five', 'Unknown']
  const priced: RemoteModel[] = [
    { id: 'unknown', name: 'Unknown' },
    { id: 'five', name: 'Five', input_price_per_million: 5 },
    { id: 'free', name: 'FreeOne', input_price_per_million: 0, output_price_per_million: 0 },
    { id: 'one-b', name: 'Another', input_price_per_million: 1 },
    { id: 'one-a', name: 'One', input_price_per_million: 1 },
  ]

  it('sorts by name case-insensitively by default, falling back to the id', () => {
    renderPicker([
      { id: 'z-id', name: 'Zeta' },
      { id: 'vendor/no-name' },
      { id: 'a-id', name: 'alpha' },
      { id: 'b-id', name: 'Beta' },
    ])

    expect(visibleNames(['alpha', 'Beta', 'Zeta', 'vendor/no-name']))
      .toEqual(['alpha', 'Beta', 'vendor/no-name', 'Zeta'])
  })

  it('sorts by ascending price with free first and unknown prices last, ties by name', () => {
    renderPicker(priced)
    fireEvent.click(screen.getByRole('button', { name: t('ai.modelSortPriceAsc') }))

    expect(visibleNames(candidates)).toEqual(['FreeOne', 'Another', 'One', 'Five', 'Unknown'])
  })

  it('sorts by descending price and keeps unknown prices last instead of inverting them to the top', () => {
    renderPicker(priced)
    fireEvent.click(screen.getByRole('button', { name: t('ai.modelSortPriceDesc') }))

    expect(visibleNames(candidates)).toEqual(['Five', 'Another', 'One', 'FreeOne', 'Unknown'])
  })
})

describe('ModelPicker price badges', () => {
  it('shows Free only when both prices are zero, $0.00/M for a free input with a paid output, and no badge without an input price', () => {
    renderPicker([
      { id: 'both-zero', name: 'BothZero', input_price_per_million: 0, output_price_per_million: 0 },
      { id: 'zero-input', name: 'ZeroInput', input_price_per_million: 0, output_price_per_million: 0.6 },
      { id: 'no-price', name: 'NoPrice' },
    ])

    expect(within(rowByName('BothZero')).getByText(t('ai.modelFree'))).toBeTruthy()

    const zeroInput = rowByName('ZeroInput')
    expect(within(zeroInput).getByText('$0.00/M')).toBeTruthy()
    expect(within(zeroInput).queryByText(t('ai.modelFree'))).toBeNull()

    const noPrice = rowByName('NoPrice')
    expect(within(noPrice).queryByText(/\$/)).toBeNull()
  })
})

describe('ModelPicker selection and keyboard', () => {
  it('selecting a row calls onChange with the id, closes the panel, and returns focus to the trigger', () => {
    const { onChange, trigger } = renderPicker([
      { id: 'vendor/alpha', name: 'Friendly Alpha', input_price_per_million: 0.15 },
    ])

    fireEvent.click(rowByName('Friendly Alpha'))

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('vendor/alpha')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('ArrowDown then Enter selects the second visible model', () => {
    const { onChange } = renderPicker([
      { id: 'm1', name: 'Alpha' },
      { id: 'm2', name: 'Beta' },
    ])
    const search = screen.getByLabelText(t('ai.modelSearch'))

    fireEvent.keyDown(search, { key: 'ArrowDown' })
    fireEvent.keyDown(search, { key: 'Enter' })

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('m2')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('Escape closes only the picker, restores trigger focus, and the released listener lets later Escape through', () => {
    const modalClose = vi.fn()
    // Mirrors the real Modal listener policy: document-level capture, which is exactly
    // why the picker must intercept Escape earlier, at window capture.
    const modalListener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') modalClose()
    }
    document.addEventListener('keydown', modalListener, true)
    try {
      const { trigger } = renderPicker([{ id: 'vendor/alpha', name: 'Friendly Alpha' }])
      const search = screen.getByLabelText(t('ai.modelSearch'))

      fireEvent.keyDown(search, { key: 'Escape' })

      expect(screen.queryByRole('listbox')).toBeNull()
      expect(document.activeElement).toBe(trigger)
      expect(modalClose).not.toHaveBeenCalled()

      // After the dropdown closed, its window listener is gone: a fresh Escape reaches the modal path.
      fireEvent.keyDown(trigger, { key: 'Escape' })
      expect(modalClose).toHaveBeenCalledTimes(1)
    } finally {
      document.removeEventListener('keydown', modalListener, true)
    }
  })
})
