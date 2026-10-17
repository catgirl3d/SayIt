// @vitest-environment jsdom
import { useRef, useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { t } from '@/i18n'
import { ModelPicker, RecommendedModels, formatUsd, priceLabel } from '../ModelPicker'
import type { RemoteModel } from '../aiProviderCatalog'

interface PickerOptions {
  /** Tag mode: the chips present at the start. */
  value?: string[]
  /** Text present in the input at the start (plain mode: the current model). */
  text?: string
  multiple?: boolean
  /** Ids the list marks with the recommended crown. */
  recommended?: string[]
  /** Put the field in a wider row and let the list match that row instead of the field. */
  anchored?: boolean
  /** Click the field once after rendering, which opens the list when a catalog is present. */
  open?: boolean
  disabled?: boolean
}

/** Stateful host: the picker is fully controlled, so a test needs something that keeps its value and typed text. */
function renderPicker(models: RemoteModel[], options: PickerOptions = {}) {
  const { multiple = true, open = true, disabled = false, anchored = false } = options
  const onAdd = vi.fn()
  const onRemove = vi.fn()

  function Host() {
    const [value, setValue] = useState(options.value ?? [])
    const [inputValue, setInputValue] = useState(options.text ?? '')
    const rowRef = useRef<HTMLDivElement>(null)
    return (
      <>
        <label htmlFor="model-field">Model</label>
        <div ref={rowRef} data-testid="row">
        <ModelPicker
          anchorRef={anchored ? rowRef : undefined}
          recommended={options.recommended}
          models={models}
          value={value}
          multiple={multiple}
          disabled={disabled}
          inputValue={inputValue}
          onInputChange={setInputValue}
          onAdd={(id) => {
            onAdd(id)
            if (multiple) setValue((current) => (current.includes(id) ? current : [...current, id]))
            else setInputValue(id)
          }}
          onRemove={(id) => {
            onRemove(id)
            setValue((current) => current.filter((item) => item !== id))
          }}
          inputId="model-field"
          placeholder="Pick a model"
        />
        </div>
      </>
    )
  }

  render(<Host />)
  const input = screen.getByLabelText('Model') as HTMLInputElement
  if (open) fireEvent.click(input)
  return { onAdd, onRemove, input }
}

const customRowLabel = (typedText: string) => t('ai.modelAddCustom', { model: typedText })

/** The catalog rows only: the trailing "Add typed text" row is not a model. */
function modelRows(typedText = ''): HTMLElement[] {
  return screen.getAllByRole('option').filter((row) => row.textContent !== customRowLabel(typedText))
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

const chip = (id: string) => screen.queryByRole('button', { name: t('ai.removeModel', { model: id }) })

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

describe('ModelPicker without a catalog', () => {
  it('is a plain text field: no list, no combobox role, no toggle', () => {
    const { input } = renderPicker([])

    expect(input.getAttribute('role')).toBeNull()
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(screen.queryByRole('button', { name: t('ai.modelListToggle') })).toBeNull()
  })

  it('commits the typed name on Enter and on a comma, and clears the field', () => {
    const { input, onAdd } = renderPicker([])

    fireEvent.change(input, { target: { value: '  gpt-5-mini ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onAdd).toHaveBeenLastCalledWith('gpt-5-mini')
    expect(input.value).toBe('')
    expect(chip('gpt-5-mini')).toBeTruthy()

    fireEvent.change(input, { target: { value: 'gpt-5.2' } })
    fireEvent.keyDown(input, { key: ',' })
    expect(onAdd).toHaveBeenLastCalledWith('gpt-5.2')
    expect(chip('gpt-5.2')).toBeTruthy()
  })

  it('ignores Enter and commas on an empty field', () => {
    const { input, onAdd } = renderPicker([])

    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: ',' })

    expect(onAdd).not.toHaveBeenCalled()
  })

  it('removes the last chip on Backspace only when the field is empty', () => {
    const { input, onRemove } = renderPicker([], { value: ['one', 'two'] })

    fireEvent.change(input, { target: { value: 'x' } })
    fireEvent.keyDown(input, { key: 'Backspace' })
    expect(onRemove).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: '' } })
    fireEvent.keyDown(input, { key: 'Backspace' })
    expect(onRemove).toHaveBeenCalledWith('two')
    expect(chip('two')).toBeNull()
    expect(chip('one')).toBeTruthy()
  })

  it('removes a chip with its button', () => {
    const { onRemove } = renderPicker([], { value: ['one'] })

    fireEvent.click(chip('one') as HTMLElement)

    expect(onRemove).toHaveBeenCalledWith('one')
    expect(chip('one')).toBeNull()
  })

  it('does nothing while disabled', () => {
    renderPicker([{ id: 'a' }], { value: ['one'], disabled: true })

    expect(screen.queryByRole('listbox')).toBeNull()
    expect((chip('one') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('ModelPicker search', () => {
  it('filters case-insensitively by display name and by id, trimming the query', () => {
    const { input } = renderPicker([
      { id: 'vendor/alpha', name: 'Friendly Alpha' },
      { id: 'beta-id', name: 'Unrelated Name' },
    ])

    fireEvent.change(input, { target: { value: '  FRIENDLY  ' } })
    expect(modelRows('FRIENDLY')).toHaveLength(1)
    expect(screen.getByText('Friendly Alpha')).toBeTruthy()

    fireEvent.change(input, { target: { value: 'BETA-ID' } })
    const rows = modelRows('BETA-ID')
    expect(rows).toHaveLength(1)
    expect(within(rows[0]).getByText('Unrelated Name')).toBeTruthy()
    expect(screen.queryByText('Friendly Alpha')).toBeNull()
  })

  it('offers the typed text as the only row when nothing matches, so an unlisted id can still be added', () => {
    const { input, onAdd } = renderPicker([{ id: 'vendor/alpha', name: 'Friendly Alpha' }])

    fireEvent.change(input, { target: { value: 'zzz' } })

    const rows = screen.getAllByRole('option')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toBe(customRowLabel('zzz'))
    expect(screen.queryByText(t('ai.modelNoMatch'))).toBeNull()

    fireEvent.click(rows[0])
    expect(onAdd).toHaveBeenCalledWith('zzz')
    expect(input.value).toBe('')
  })

  it('does not offer a typed id the catalog lists exactly or that is already chosen, and then reports no match', () => {
    const { input } = renderPicker([{ id: 'vendor/alpha', name: 'Friendly Alpha' }], { value: ['zzz'] })

    fireEvent.change(input, { target: { value: 'vendor/alpha' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.queryByText(customRowLabel('vendor/alpha'))).toBeNull()

    fireEvent.change(input, { target: { value: 'zzz' } })
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByText(t('ai.modelNoMatch'))).toBeTruthy()
  })

  it('opens the list when typing after it was closed with Escape', () => {
    const { input } = renderPicker([{ id: 'vendor/alpha' }])

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('listbox')).toBeNull()

    fireEvent.change(input, { target: { value: 'alp' } })
    expect(screen.getByRole('listbox')).toBeTruthy()
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

  it('starts the keyboard highlight on the chosen model, so Enter keeps it', () => {
    const { input, onAdd } = renderPicker(catalog, { text: 'm07', multiple: false })

    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(onAdd).toHaveBeenCalledWith('m07')
  })

  it('moves the arrows from the chosen model, not from the first row', () => {
    const { input, onAdd } = renderPicker(catalog, { text: 'm07', multiple: false })

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onAdd).toHaveBeenCalledWith('m08')
  })

  it('falls back to the first row when the chosen model is not in the list', () => {
    const { input, onAdd } = renderPicker(catalog, { text: 'gone', multiple: false })

    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onAdd).toHaveBeenCalledWith('m00')
  })

  it('opens on ArrowDown with the highlight on the chosen model', () => {
    const { input, onAdd } = renderPicker(catalog, { text: 'm05', multiple: false, open: false })

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getByRole('listbox')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onAdd).toHaveBeenCalledWith('m05')
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

    it('opens with the chosen model centered in the list', () => {
      mockLayout()
      renderPicker(catalog, { value: ['m10'] })

      expect(screen.getByRole('listbox').scrollTop).toBe(10 * rowStep - (listHeight - rowHeight) / 2)
    })

    it('reveals a row reached with the arrow keys with the least movement', () => {
      mockLayout()
      const { input } = renderPicker(catalog, { value: ['m00'] })
      const list = screen.getByRole('listbox')

      expect(list.scrollTop).toBe(0)
      // Rows 0-4 fit the 270px viewport (5 * 54 = 270); the sixth row is the first one below the edge.
      for (let i = 0; i < 5; i += 1) fireEvent.keyDown(input, { key: 'ArrowDown' })

      expect(list.scrollTop).toBe(5 * rowStep + rowHeight - listHeight)
    })
  })
})

describe('ModelPicker choosing several models', () => {
  const alpha: RemoteModel = { id: 'vendor/alpha', name: 'Friendly Alpha' }
  const beta: RemoteModel = { id: 'beta-id', name: 'Beta' }

  it('marks the chosen rows and keeps the list open while models are toggled', () => {
    const { onAdd, onRemove } = renderPicker([alpha, beta], { value: ['vendor/alpha'] })

    expect(rowByName('Friendly Alpha').getAttribute('aria-selected')).toBe('true')
    expect(rowByName('Beta').getAttribute('aria-selected')).toBe('false')
    expect(screen.getByRole('listbox').getAttribute('aria-multiselectable')).toBe('true')

    fireEvent.click(rowByName('Beta'))
    expect(onAdd).toHaveBeenCalledWith('beta-id')
    expect(chip('beta-id')).toBeTruthy()
    expect(screen.getByRole('listbox')).toBeTruthy()
    expect(rowByName('Beta').getAttribute('aria-selected')).toBe('true')

    fireEvent.click(rowByName('Friendly Alpha'))
    expect(onRemove).toHaveBeenCalledWith('vendor/alpha')
    expect(chip('vendor/alpha')).toBeNull()
    expect(rowByName('Friendly Alpha').getAttribute('aria-selected')).toBe('false')
  })

  it('clears the typed filter after a pick so the whole catalog is listed again', () => {
    const { input } = renderPicker([alpha, beta])

    fireEvent.change(input, { target: { value: 'alpha' } })
    fireEvent.click(modelRows('alpha')[0])

    expect(input.value).toBe('')
    expect(modelRows()).toHaveLength(2)
  })

  it('ArrowDown then Enter toggles the second visible model', () => {
    const { input, onAdd } = renderPicker([
      { id: 'm1', name: 'Alpha' },
      { id: 'm2', name: 'Beta' },
    ])

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(onAdd).toHaveBeenCalledWith('m2')
    expect(screen.getByRole('listbox')).toBeTruthy()
  })

  it('wraps the highlight around the rows, the add-typed row included', () => {
    const { input, onAdd } = renderPicker([{ id: 'm1', name: 'Alpha' }])

    fireEvent.change(input, { target: { value: 'al' } })
    // Rows: "Alpha" (highlighted), then the add-typed row; ArrowUp wraps from the first row to the last.
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onAdd).toHaveBeenCalledWith('al')
  })

  it('adds the typed id on Enter when the catalog has no match', () => {
    const { input, onAdd } = renderPicker([alpha])

    fireEvent.change(input, { target: { value: 'my/private-model' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onAdd).toHaveBeenCalledWith('my/private-model')
    expect(chip('my/private-model')).toBeTruthy()
    expect(input.value).toBe('')
  })

  it('commits the typed text with a comma even while the list is open', () => {
    const { input, onAdd } = renderPicker([alpha])

    fireEvent.change(input, { target: { value: 'alpha' } })
    fireEvent.keyDown(input, { key: ',' })

    expect(onAdd).toHaveBeenCalledWith('alpha')
  })
})

describe('ModelPicker as a plain field for one model', () => {
  const catalog: RemoteModel[] = [
    { id: 'vendor/alpha', name: 'Friendly Alpha' },
    { id: 'beta-id', name: 'Beta' },
    { id: 'gamma-id', name: 'Gamma' },
  ]

  it('has no chips, no Backspace chip removal, and keeps a comma as text', () => {
    const { input, onRemove } = renderPicker(catalog, { text: 'beta-id', multiple: false, open: false })

    expect(screen.queryAllByRole('button', { name: /^Remove / })).toHaveLength(0)
    expect(input.value).toBe('beta-id')

    fireEvent.change(input, { target: { value: '' } })
    fireEvent.keyDown(input, { key: 'Backspace' })
    fireEvent.keyDown(input, { key: ',' })
    expect(onRemove).not.toHaveBeenCalled()
  })

  it('opens with the whole catalog and the current model marked, although the field holds its text', () => {
    renderPicker(catalog, { text: 'beta-id', multiple: false })

    expect(screen.getAllByRole('option')).toHaveLength(3)
    expect(rowByName('Beta').getAttribute('aria-selected')).toBe('true')
    expect(rowByName('Gamma').getAttribute('aria-selected')).toBe('false')
    expect(screen.getByRole('listbox').getAttribute('aria-multiselectable')).toBe('false')
  })

  it('filters once the text is edited and offers no add-typed row', () => {
    const { input } = renderPicker(catalog, { text: 'beta-id', multiple: false })

    fireEvent.change(input, { target: { value: 'gam' } })

    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(rowByName('Gamma')).toBeTruthy()
    expect(screen.queryByText(customRowLabel('gam'))).toBeNull()
  })

  it('shows no rows for text the catalog does not list, and Enter closes the list keeping the text', () => {
    const { input, onAdd } = renderPicker(catalog, { text: 'beta-id', multiple: false })

    fireEvent.change(input, { target: { value: 'my/private-model' } })
    expect(screen.getByText(t('ai.modelNoMatch'))).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(screen.queryByRole('listbox')).toBeNull()
    expect(input.value).toBe('my/private-model')
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('a row replaces the text, closes the list, and keeps focus in the field', () => {
    const { input, onAdd } = renderPicker(catalog, { text: 'beta-id', multiple: false })

    fireEvent.click(rowByName('Friendly Alpha'))

    expect(onAdd).toHaveBeenCalledTimes(1)
    expect(onAdd).toHaveBeenCalledWith('vendor/alpha')
    expect(input.value).toBe('vendor/alpha')
    expect(screen.queryByRole('listbox')).toBeNull()
    expect(document.activeElement).toBe(input)
  })

  it('lists the whole catalog again when reopened after the text was edited', () => {
    const { input } = renderPicker(catalog, { text: 'beta-id', multiple: false })

    fireEvent.change(input, { target: { value: 'gam' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.click(input)

    expect(screen.getAllByRole('option')).toHaveLength(3)
  })

  it('Enter picks the first match of the edited text, the way a combobox completes it', () => {
    const { input, onAdd } = renderPicker(catalog, { text: 'beta-id', multiple: false })

    fireEvent.change(input, { target: { value: 'gam' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onAdd).toHaveBeenCalledWith('gamma-id')
    expect(input.value).toBe('gamma-id')
  })

  it('Enter on a closed list does nothing', () => {
    const { input, onAdd } = renderPicker(catalog, { text: 'beta-id', multiple: false, open: false })

    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onAdd).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox')).toBeNull()
  })
})

describe('ModelPicker recommended models', () => {
  const crown = () => screen.queryAllByRole('img', { name: t('local.recommended') })

  it('marks recommended rows with the crown and leaves the sort order alone', () => {
    renderPicker(
      [{ id: 'z-id', name: 'Zeta' }, { id: 'a-id', name: 'Alpha' }, { id: 'm-id', name: 'Mid' }],
      { recommended: ['z-id'] },
    )

    expect(visibleNames(['Alpha', 'Mid', 'Zeta'])).toEqual(['Alpha', 'Mid', 'Zeta'])
    expect(crown()).toHaveLength(1)
    expect(within(rowByName('Zeta')).getByRole('img', { name: t('local.recommended') })).toBeTruthy()
    expect(within(rowByName('Alpha')).queryByRole('img')).toBeNull()
  })

  it('shows no crown without recommendations', () => {
    renderPicker([{ id: 'a-id', name: 'Alpha' }])

    expect(crown()).toHaveLength(0)
  })
})

describe('RecommendedModels', () => {
  it('offers each recommendation as a button, in the given order, and reports the pick', () => {
    const onPick = vi.fn()
    render(<RecommendedModels models={['one/a', 'two/b']} chosen={[]} onPick={onPick} />)

    expect(screen.getByLabelText(t('local.recommended'))).toBeTruthy()
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['one/a', 'two/b'])

    fireEvent.click(screen.getByRole('button', { name: 'two/b' }))
    expect(onPick).toHaveBeenCalledWith('two/b')
  })

  it('leaves out what is already chosen and disappears once everything is', () => {
    const { rerender } = render(<RecommendedModels models={['one/a', 'two/b']} chosen={['one/a']} onPick={vi.fn()} />)
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['two/b'])

    rerender(<RecommendedModels models={['one/a', 'two/b']} chosen={['one/a', 'two/b']} onPick={vi.fn()} />)
    expect(screen.queryByLabelText(t('local.recommended'))).toBeNull()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('renders nothing without recommendations and disables the buttons while busy', () => {
    const { rerender } = render(<RecommendedModels models={[]} chosen={[]} onPick={vi.fn()} />)
    expect(screen.queryByLabelText(t('local.recommended'))).toBeNull()

    rerender(<RecommendedModels models={['one/a']} chosen={[]} onPick={vi.fn()} disabled />)
    expect((screen.getByRole('button', { name: 'one/a' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('ModelPicker list width', () => {
  const restores: Array<() => void> = []

  afterEach(() => {
    while (restores.length > 0) restores.pop()?.()
  })

  // jsdom has no layout: the row is 480px wide and the field inside it only 300px.
  function mockBoxes() {
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const isRow = this.getAttribute('data-testid') === 'row'
      const width = isRow ? 480 : 300
      return { x: 10, y: 100, left: 10, top: 100, right: 10 + width, bottom: 136, width, height: 36, toJSON: () => ({}) }
    })
    restores.push(() => spy.mockRestore())
  }

  const panelOf = () => screen.getByRole('listbox').parentElement as HTMLElement

  it('matches the field by default', () => {
    mockBoxes()
    renderPicker([{ id: 'a' }])

    expect(panelOf().style.width).toBe('300px')
  })

  it('matches the anchor row when one is given, so names and ids are not cut off by a neighbouring button', () => {
    mockBoxes()
    renderPicker([{ id: 'a' }], { anchored: true })

    expect(panelOf().style.width).toBe('480px')
    expect(panelOf().style.left).toBe('10px')
  })
})

describe('ModelPicker list placement', () => {
  const restores: Array<() => void> = []

  afterEach(() => {
    while (restores.length > 0) restores.pop()?.()
  })

  // jsdom has no layout: a 36px field at `top`, in a 700px high window.
  function placeField(top: number) {
    const innerHeight = window.innerHeight
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 700 })
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      x: 10, y: top, left: 10, top, right: 310, bottom: top + 36, width: 300, height: 36, toJSON: () => ({}),
    }))
    restores.push(() => {
      spy.mockRestore()
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: innerHeight })
    })
  }

  const panelOf = () => screen.getByRole('listbox').parentElement as HTMLElement

  it('opens below the field when there is room', () => {
    placeField(100)
    renderPicker([{ id: 'a' }])

    // Space below: 700 - 136 - 8 = 556, enough for the 360px cap.
    expect(panelOf().style.top).toBe('140px')
    expect(panelOf().style.bottom).toBe('')
    expect(panelOf().style.maxHeight).toBe('360px')
  })

  it('opens above the field when below is tight, hugging the field whatever the list height', () => {
    placeField(500)
    renderPicker([{ id: 'a' }])

    // Space below: 700 - 536 - 8 = 156 < 320, space above: 492. The panel is pinned by its bottom edge,
    // 700 - 500 + 4 = 204px up from the window bottom, so a short list leaves no gap above the field.
    expect(panelOf().style.bottom).toBe('204px')
    expect(panelOf().style.top).toBe('')
    expect(panelOf().style.maxHeight).toBe('360px')
  })

  it('stays below when above has even less room', () => {
    placeField(60)
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 200 })
    renderPicker([{ id: 'a' }])

    // Below: 200 - 96 - 8 = 96; above: 52. Neither is comfortable, so the larger side is used.
    expect(panelOf().style.top).toBe('100px')
    expect(panelOf().style.maxHeight).toBe('120px')
  })

  it('follows the field when it is scrolled so that the room changes', () => {
    placeField(100)
    renderPicker([{ id: 'a' }])
    expect(panelOf().style.top).toBe('140px')

    restores.pop()?.()
    placeField(500)
    fireEvent.scroll(window)

    expect(panelOf().style.bottom).toBe('204px')
  })
})

describe('ModelPicker closing', () => {
  it('Escape closes only the picker, keeps focus in the field, and the released listener lets later Escape through', () => {
    const modalClose = vi.fn()
    // Mirrors the real Modal listener policy: document-level capture, which is exactly
    // why the picker must intercept Escape earlier, at window capture.
    const modalListener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') modalClose()
    }
    document.addEventListener('keydown', modalListener, true)
    try {
      const { input } = renderPicker([{ id: 'vendor/alpha', name: 'Friendly Alpha' }])

      fireEvent.keyDown(input, { key: 'Escape' })

      expect(screen.queryByRole('listbox')).toBeNull()
      expect(document.activeElement).toBe(input)
      expect(modalClose).not.toHaveBeenCalled()

      // After the dropdown closed, its window listener is gone: a fresh Escape reaches the modal path.
      fireEvent.keyDown(input, { key: 'Escape' })
      expect(modalClose).toHaveBeenCalledTimes(1)
    } finally {
      document.removeEventListener('keydown', modalListener, true)
    }
  })

  it('closes on a mousedown outside and on Tab, but not on a mousedown inside the list', () => {
    const { input } = renderPicker([{ id: 'vendor/alpha', name: 'Friendly Alpha' }])

    fireEvent.mouseDown(screen.getByRole('listbox'))
    expect(screen.getByRole('listbox')).toBeTruthy()

    fireEvent.mouseDown(document.body)
    expect(screen.queryByRole('listbox')).toBeNull()

    fireEvent.click(input)
    expect(screen.getByRole('listbox')).toBeTruthy()
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('the chevron toggles the list', () => {
    renderPicker([{ id: 'vendor/alpha' }], { open: false })
    const toggle = screen.getByRole('button', { name: t('ai.modelListToggle') })

    fireEvent.click(toggle)
    expect(screen.getByRole('listbox')).toBeTruthy()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(toggle)
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('rows and the sort buttons keep the input focused instead of taking focus', () => {
    renderPicker([{ id: 'vendor/alpha', name: 'Friendly Alpha' }])

    const rowEvent = fireEvent.mouseDown(rowByName('Friendly Alpha'))
    const sortEvent = fireEvent.mouseDown(screen.getByRole('button', { name: t('ai.modelSortPriceAsc') }))

    // fireEvent returns false when the handler called preventDefault.
    expect(rowEvent).toBe(false)
    expect(sortEvent).toBe(false)
  })
})
