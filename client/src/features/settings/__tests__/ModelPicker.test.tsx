// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { t } from '@/i18n'
import { ModelPicker, formatUsd, priceLabel, type ModelPickerProps } from '../ModelPicker'
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
  // Found by its popup role, not by name: with a value set the trigger shows the model name, not the placeholder.
  const trigger = screen.getAllByRole('button').find((button) => button.getAttribute('aria-haspopup') === 'listbox')
  if (!trigger) throw new Error('picker trigger not found')
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
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(0.15)).toBe('$0.15')
    expect(formatUsd(25)).toBe('$25.00')
    expect(formatUsd(0.003)).toBe('$0.003')
  })
})

describe('priceLabel', () => {
  it('reports nothing without any price, free only for two zeros, both amounts otherwise with a dash for a missing side', () => {
    expect(priceLabel({ id: 'm' })).toEqual({ kind: 'none' })
    expect(priceLabel({ id: 'm', input_price_per_million: 0 })).toEqual({ kind: 'price', input: '$0.00', output: '—' })
    expect(priceLabel({ id: 'm', output_price_per_million: 0.6 })).toEqual({ kind: 'price', input: '—', output: '$0.60' })
    expect(priceLabel({ id: 'm', input_price_per_million: 0, output_price_per_million: 0 })).toEqual({ kind: 'free' })
    expect(priceLabel({ id: 'm', input_price_per_million: 0.15, output_price_per_million: 0.6 }))
      .toEqual({ kind: 'price', input: '$0.15', output: '$0.60' })
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
  // The input prices run opposite to the output prices on purpose: the order must follow the output price.
  const priced: RemoteModel[] = [
    { id: 'unknown', name: 'Unknown', input_price_per_million: 3 },
    { id: 'five', name: 'Five', input_price_per_million: 0.1, output_price_per_million: 5 },
    { id: 'free', name: 'FreeOne', input_price_per_million: 0, output_price_per_million: 0 },
    { id: 'one-b', name: 'Another', input_price_per_million: 9, output_price_per_million: 1 },
    { id: 'one-a', name: 'One', input_price_per_million: 9, output_price_per_million: 1 },
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

  it('sorts by ascending output price with free first and unknown output prices last, ties by name', () => {
    renderPicker(priced)
    fireEvent.click(screen.getByRole('button', { name: t('ai.modelSortPriceAsc') }))

    expect(visibleNames(candidates)).toEqual(['FreeOne', 'Another', 'One', 'Five', 'Unknown'])
  })

  it('sorts by descending output price and keeps unknown prices last instead of inverting them to the top', () => {
    renderPicker(priced)
    fireEvent.click(screen.getByRole('button', { name: t('ai.modelSortPriceDesc') }))

    expect(visibleNames(candidates)).toEqual(['Five', 'Another', 'One', 'FreeOne', 'Unknown'])
  })
})

describe('ModelPicker row prices', () => {
  it('shows Free only when both prices are zero, labelled in/out amounts otherwise, and nothing without any price', () => {
    renderPicker([
      { id: 'both-zero', name: 'BothZero', input_price_per_million: 0, output_price_per_million: 0 },
      { id: 'zero-input', name: 'ZeroInput', input_price_per_million: 0, output_price_per_million: 0.6 },
      { id: 'no-price', name: 'NoPrice' },
    ])

    expect(within(rowByName('BothZero')).getByText(t('ai.modelFree'))).toBeTruthy()

    const zeroInput = rowByName('ZeroInput')
    expect(within(zeroInput).getByText(t('ai.modelPriceIn'))).toBeTruthy()
    expect(within(zeroInput).getByText('$0.00')).toBeTruthy()
    expect(within(zeroInput).getByText(t('ai.modelPriceOut'))).toBeTruthy()
    expect(within(zeroInput).getByText('$0.60')).toBeTruthy()
    expect(within(zeroInput).queryByText(t('ai.modelFree'))).toBeNull()

    const noPrice = rowByName('NoPrice')
    expect(within(noPrice).queryByText(/\$/)).toBeNull()
    expect(within(noPrice).queryByText(t('ai.modelPriceIn'))).toBeNull()
  })

  it('spells out both prices per million tokens in the price tooltip', () => {
    renderPicker([{ id: 'paid', name: 'Paid', input_price_per_million: 0.15, output_price_per_million: 0.6 }])

    expect(within(rowByName('Paid')).getByTitle(t('ai.modelPriceTitle', { input: '$0.15', output: '$0.60' }))).toBeTruthy()
  })

  it('tells that the price sort uses the output price', () => {
    renderPicker([{ id: 'paid', name: 'Paid', input_price_per_million: 1, output_price_per_million: 2 }])

    expect(screen.getByRole('button', { name: t('ai.modelSortPriceAsc') }).getAttribute('title')).toBe(t('ai.modelSortPriceTitle'))
    expect(screen.getByRole('button', { name: t('ai.modelSortPriceDesc') }).getAttribute('title')).toBe(t('ai.modelSortPriceTitle'))
  })
})

describe('ModelPicker opening position', () => {
  const catalog: RemoteModel[] = Array.from({ length: 20 }, (_, i) => ({
    id: `m${String(i).padStart(2, '0')}`,
    name: `Model ${String(i).padStart(2, '0')}`,
  }))

  it('starts the keyboard highlight on the current model, so Enter keeps it', () => {
    const { onChange } = renderPicker(catalog, { value: 'm07' })

    fireEvent.keyDown(screen.getByLabelText(t('ai.modelSearch')), { key: 'Enter' })

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith('m07')
  })

  it('moves the arrows from the current model, not from the first row', () => {
    const { onChange } = renderPicker(catalog, { value: 'm07' })
    const search = screen.getByLabelText(t('ai.modelSearch'))

    fireEvent.keyDown(search, { key: 'ArrowDown' })
    fireEvent.keyDown(search, { key: 'Enter' })

    expect(onChange).toHaveBeenCalledWith('m08')
  })

  it('falls back to the first row when the current model is not in the list', () => {
    const { onChange } = renderPicker(catalog, { value: 'gone' })

    fireEvent.keyDown(screen.getByLabelText(t('ai.modelSearch')), { key: 'Enter' })

    expect(onChange).toHaveBeenCalledWith('m00')
  })

  describe('with measured layout', () => {
    const rowHeight = 52
    const rowStep = 54
    const listHeight = 270
    const restores: Array<() => void> = []

    afterEach(() => {
      while (restores.length > 0) restores.pop()?.()
    })

    // jsdom has no layout: report a 54px row step (52px rows plus a 2px gap) and a 270px viewport.
    function mockLayout() {
      const top = vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
        return this.getAttribute('role') === 'option' ? Array.from(this.parentElement?.children ?? []).indexOf(this) * rowStep : 0
      })
      const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
        return this.getAttribute('role') === 'option' ? rowHeight : 0
      })
      const client = vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
        return this.getAttribute('role') === 'listbox' ? listHeight : 0
      })
      restores.push(() => { top.mockRestore(); height.mockRestore(); client.mockRestore() })
    }

    it('opens with the current model centered in the list', () => {
      mockLayout()
      renderPicker(catalog, { value: 'm10' })

      expect(screen.getByRole('listbox').scrollTop).toBe(10 * rowStep - (listHeight - rowHeight) / 2)
    })

    it('reveals a row reached with the arrow keys with the least movement', () => {
      mockLayout()
      renderPicker(catalog, { value: 'm00' })
      const list = screen.getByRole('listbox')
      const search = screen.getByLabelText(t('ai.modelSearch'))

      expect(list.scrollTop).toBe(0)
      // Rows 0-4 fit the 270px viewport (5 * 54 = 270); the sixth row is the first one below the edge.
      for (let i = 0; i < 5; i += 1) fireEvent.keyDown(search, { key: 'ArrowDown' })

      expect(list.scrollTop).toBe(5 * rowStep + rowHeight - listHeight)
    })
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
