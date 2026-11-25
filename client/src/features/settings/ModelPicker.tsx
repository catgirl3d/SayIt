// Model field for the AI editor: a text input backed by a searchable, sortable catalog.
//
// Why a feature-local component instead of extending components/ui/select.tsx:
// an OpenRouter catalog has ~470 entries with per-model metadata, while the shared
// Select is a deliberately minimal control used elsewhere. The field needs chips, typed
// custom ids, search, sorting, price badges, and keyboard navigation that no other Select
// consumer asks for.
//
// Two meanings share the control. A new service collects several models, so the field is a tag
// input: Enter or a comma commits the typed id as a chip. An existing card holds exactly one
// model, so the field is a plain text input whose text is the model; chips for a single value
// would only add a second row of padding. Once the catalog is loaded the field is also a
// combobox: in tag mode the typed text filters the list, a click or Enter toggles a row, and an
// id the provider does not list can still be added as typed; in plain mode picking a row
// replaces the text, and the list opens unfiltered so the whole catalog is visible.
// The list is a body portal; focus never leaves the input, so rows and sort buttons swallow
// mousedown instead of taking focus.
//
// Escape routing note: Escape is handled by usePopover. Its window-capture listener runs before
// the parent Modal's document-capture listener (components/ui/modal.tsx) and participates in the
// shared popover layer stack, so Escape closes only this list and returns focus to the input.

import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Crown, Plus, X } from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import { usePopover } from '@/hooks/usePopover'
import { useT } from '@/i18n/useT'
import { cn } from '@/lib/utils'
import type { RemoteModel } from './aiProviderCatalog'

export type ModelSort = 'name' | 'priceAsc' | 'priceDesc'

// Room the list wants below the field before it considers opening above; the list never grows past the cap.
const LIST_PLACEMENT = { kind: 'list', preferredSpace: 320, maxHeight: 360 } as const

/** The display name shown for a model: its trimmed name, or the id as fallback. */
function displayName(model: RemoteModel): string {
  return model.name?.trim() || model.id
}

function knownPrice(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Case-insensitive text comparison; the sort input order is stable for equal keys. */
function compareText(a: string, b: string): number {
  const left = a.toLowerCase()
  const right = b.toLowerCase()
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/** Name order: display name (fallback id) first, id as the tiebreaker. */
function compareByName(a: RemoteModel, b: RemoteModel): number {
  return compareText(displayName(a), displayName(b)) || compareText(a.id, b.id)
}

/**
 * Price order by output price in the given direction: it is the larger tariff and it also
 * bills reasoning tokens, so it tracks the real cost better than the input price.
 * Entries without a known output price stay last in both directions — the comparator is
 * not inverted, so unknown prices never float to the top when the direction flips.
 * Ties fall back to names.
 */
function compareByPrice(a: RemoteModel, b: RemoteModel, direction: 1 | -1): number {
  const left = knownPrice(a.output_price_per_million)
  const right = knownPrice(b.output_price_per_million)
  if (left !== undefined && right !== undefined) {
    if (left !== right) return (left - right) * direction
  } else if (left !== undefined || right !== undefined) {
    return left !== undefined ? -1 : 1
  }
  return compareByName(a, b)
}

/** Pure, stable sorting for the picker list. */
export function sortModels(models: RemoteModel[], sort: ModelSort): RemoteModel[] {
  const out = [...models]
  if (sort === 'name') {
    out.sort(compareByName)
  } else {
    const direction = sort === 'priceAsc' ? 1 : -1
    out.sort((a, b) => compareByPrice(a, b, direction))
  }
  return out
}

/** Case-insensitive substring filter against the display name and the id. */
export function filterModels(models: RemoteModel[], query: string): RemoteModel[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return models
  return models.filter(
    (model) => displayName(model).toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle),
  )
}

/**
 * A USD amount per million tokens, without the unit (the legend and tooltip carry it).
 * Minimum two decimals; sub-cent prices get six decimals with trailing zeros stripped,
 * and never scientific notation.
 */
export function formatUsd(value: number): string {
  if (value === 0) return '$0.00'
  if (value >= 0.01) return `$${value.toFixed(2)}`
  return `$${value.toFixed(6).replace(/0+$/, '')}`
}

/** One side of a price pair; an em dash stands for a price the provider did not report. */
function formatPriceOrDash(value: number | undefined): string {
  return value === undefined ? '—' : formatUsd(value)
}

export type PriceLabel = { kind: 'none' } | { kind: 'free' } | { kind: 'price'; input: string; output: string }

/**
 * Price shown on one row. Neither price known -> nothing; both prices exactly zero ->
 * "Free"; otherwise the input and output amounts, each already formatted. Translating
 * the result is the component's job.
 */
export function priceLabel(model: RemoteModel): PriceLabel {
  const input = knownPrice(model.input_price_per_million)
  const output = knownPrice(model.output_price_per_million)
  if (input === undefined && output === undefined) return { kind: 'none' }
  if (input === 0 && output === 0) return { kind: 'free' }
  return { kind: 'price', input: formatPriceOrDash(input), output: formatPriceOrDash(output) }
}

export interface ModelPickerProps {
  /** Fetched catalog. While it is empty the field is a plain tag input without a list. */
  models: RemoteModel[]
  /** Tag mode only: the chosen model ids, shown as chips inside the field. */
  value: string[]
  /** Tag mode: several models may be chosen. Otherwise the field is plain text holding the one model. */
  multiple?: boolean
  /** Tag mode: a model was committed. Plain mode: a catalog row was picked, so the text becomes this id. */
  onAdd: (id: string) => void
  /** Tag mode only: a chip was removed. */
  onRemove: (id: string) => void
  /** The text in the input. Owned by the parent so unfinished input counts as an unsaved change. */
  inputValue: string
  onInputChange: (text: string) => void
  /** Id of the text input, so a visible <label htmlFor> reaches the control. */
  inputId?: string
  /**
   * Element whose box the list matches instead of the field's own. The field often shares a row with a
   * button, and a list as narrow as the field cuts model names and ids off.
   */
  anchorRef?: RefObject<HTMLElement | null>
  /** Ids to tag as recommended in the list. The list keeps the chosen sort; the tag only marks them. */
  recommended?: string[]
  placeholder?: string
  disabled?: boolean
}

export function ModelPicker({
  models,
  value,
  multiple = false,
  onAdd,
  onRemove,
  inputValue,
  onInputChange,
  inputId,
  anchorRef,
  recommended = [],
  placeholder,
  disabled = false,
}: ModelPickerProps) {
  const t = useT()
  const listId = useId()
  const [isOpen, setIsOpen] = useState(false)
  const [sort, setSort] = useState<ModelSort>('name')
  const [activeIndex, setActiveIndex] = useState(0)
  /** Plain mode: the text is the current model, so it only filters the list once the user edits it. */
  const [typedSinceOpen, setTypedSinceOpen] = useState(false)
  const fieldRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  /** Attached only to the keyboard-highlighted row, so the effect below can find it. */
  const activeRowRef = useRef<HTMLButtonElement | null>(null)
  /** Set when the panel opens: the first scroll centers the row, later ones only reveal it. */
  const centerActiveRowRef = useRef(false)

  const hasCatalog = models.length > 0
  const typed = inputValue.trim()
  const filterText = multiple || typedSinceOpen ? inputValue : ''
  const filtered = useMemo(() => sortModels(filterModels(models, filterText), sort), [models, filterText, sort])
  /** The rows to mark as chosen: the chips, or the text of the plain field. */
  const chosen = multiple ? value : typed ? [typed] : []
  /** Tag mode: typed text the catalog does not list (and that is not chosen yet) is offered as a last row. */
  const customId = multiple && hasCatalog && typed && !models.some((model) => model.id === typed) && !value.includes(typed) ? typed : ''
  const optionCount = filtered.length + (customId ? 1 : 0)
  const highlightIndex = optionCount === 0 ? -1 : Math.min(activeIndex, optionCount - 1)
  const panelOpen = isOpen && hasCatalog
  // triggerRef is the field alone: the anchor may be a wider row, and a mousedown on that row
  // outside the field must still close the list.
  const { panelRef, panelStyle, positioned } = usePopover({
    open: panelOpen,
    onDismiss: () => setIsOpen(false),
    anchorRef: anchorRef ?? fieldRef,
    triggerRef: fieldRef,
    returnFocusRef: inputRef,
    placement: LIST_PLACEMENT,
  })
  const panelVisible = panelOpen && positioned

  // Keeps the highlighted row inside the scrolled list: centered when the panel opens (so the
  // chosen model is visible at once), revealed with the least movement afterwards. The list is
  // scrolled by hand instead of scrollIntoView because that would also scroll the page behind the
  // dialog. Depends on the panel's visibility flag, not on panelStyle: that object is replaced on
  // every re-measure and would drag the list back to the highlighted row.
  useLayoutEffect(() => {
    const list = listRef.current
    const row = activeRowRef.current
    if (!panelVisible || !list || !row) return
    const rowTop = row.offsetTop
    const rowBottom = rowTop + row.offsetHeight
    if (centerActiveRowRef.current) {
      list.scrollTop = Math.max(0, rowTop - (list.clientHeight - row.offsetHeight) / 2)
      centerActiveRowRef.current = false
    } else if (rowTop < list.scrollTop) {
      list.scrollTop = rowTop
    } else if (rowBottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = rowBottom - list.clientHeight
    }
  }, [panelVisible, highlightIndex, filtered])

  /** Opens the list; `centerOnChosen` puts the keyboard highlight (and the scroll) on the first chosen row. */
  function openPanel(centerOnChosen: boolean) {
    if (disabled || !hasCatalog || panelOpen) return
    setTypedSinceOpen(false)
    if (centerOnChosen) {
      // Rows as they will be listed after the reset above: plain mode lists the whole catalog.
      const rows = sortModels(filterModels(models, multiple ? inputValue : ''), sort)
      setActiveIndex(Math.max(0, rows.findIndex((model) => chosen.includes(model.id))))
      centerActiveRowRef.current = true
    }
    setIsOpen(true)
  }

  function togglePanel() {
    if (panelOpen) {
      setIsOpen(false)
      return
    }
    inputRef.current?.focus({ preventScroll: true })
    openPanel(true)
  }

  function handleInputChange(text: string) {
    onInputChange(text)
    setTypedSinceOpen(true)
    setActiveIndex(0)
    if (hasCatalog && !disabled) setIsOpen(true)
  }

  /** Tag mode: adds the typed text as a model id of its own, whether or not the catalog lists it. */
  function commitTyped() {
    if (!typed) return
    onAdd(typed)
    onInputChange('')
    setActiveIndex(0)
  }

  /** Chooses (or, in multiple mode, un-chooses) a catalog row. */
  function toggleModel(id: string) {
    if (!multiple) {
      onAdd(id)
      setTypedSinceOpen(false)
      setIsOpen(false)
      inputRef.current?.focus({ preventScroll: true })
      return
    }
    const cleared = inputValue !== ''
    onInputChange('')
    if (value.includes(id)) onRemove(id)
    else onAdd(id)
    // The panel stays open for the next pick. Clearing the filter swaps the list for the whole
    // catalog, so the touched row is found again and scrolled to; otherwise the list stays put.
    setActiveIndex(Math.max(0, sortModels(models, sort).findIndex((model) => model.id === id)))
    centerActiveRowRef.current = cleared
  }

  function activateOption(index: number) {
    if (index < filtered.length) toggleModel(filtered[index].id)
    else commitTyped()
  }

  function handleInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!hasCatalog) return
      event.preventDefault()
      if (!panelOpen) {
        openPanel(true)
        return
      }
      if (optionCount === 0) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActiveIndex((index) => (Math.min(index, optionCount - 1) + step + optionCount) % optionCount)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (panelOpen && highlightIndex >= 0) activateOption(highlightIndex)
      else if (multiple) commitTyped()
      else setIsOpen(false)
      return
    }
    if (multiple && event.key === ',') {
      // A comma is never part of a model id, so it ends the name like Enter does.
      event.preventDefault()
      commitTyped()
      return
    }
    if (multiple && event.key === 'Backspace' && inputValue === '' && value.length > 0) {
      onRemove(value[value.length - 1])
      return
    }
    if (event.key === 'Tab') setIsOpen(false)
  }

  function priceTitle(model: RemoteModel): string | undefined {
    const input = knownPrice(model.input_price_per_million)
    const output = knownPrice(model.output_price_per_million)
    if (input === undefined && output === undefined) return undefined
    return t('ai.modelPriceTitle', {
      input: formatPriceOrDash(input),
      output: formatPriceOrDash(output),
    })
  }

  /** Rows keep the input focused: a mousedown that moved focus would close nothing but break typing. */
  const keepInputFocus = (event: { preventDefault: () => void }) => event.preventDefault()
  const rowId = (index: number) => `${listId}-row-${index}`

  const dropdown = panelOpen && positioned ? createPortal(
    <div
      ref={panelRef}
      className="fixed z-[9999] flex flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-xl"
      style={panelStyle}
    >
      <div className="flex items-center gap-2 border-b border-border px-3 pb-2 pt-2 text-xs">
        <span className="text-muted-foreground">{t('ai.modelSortLabel')}</span>
        <div className="flex gap-0.5 rounded-md bg-input-bg p-0.5">
          {([
            { value: 'name', label: t('ai.modelSortName'), title: undefined },
            { value: 'priceAsc', label: t('ai.modelSortPriceAsc'), title: t('ai.modelSortPriceTitle') },
            { value: 'priceDesc', label: t('ai.modelSortPriceDesc'), title: t('ai.modelSortPriceTitle') },
          ] as const).map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={sort === option.value}
              title={option.title}
              onMouseDown={keepInputFocus}
              onClick={() => { setSort(option.value); setActiveIndex(0) }}
              className={cn(
                'h-6 rounded px-2.5 transition-colors',
                sort === option.value ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {optionCount === 0 ? (
        <div className="px-3 py-6 text-center text-sm text-muted-foreground">{t('ai.modelNoMatch')}</div>
      ) : (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-multiselectable={multiple}
          className="relative flex flex-col gap-0.5 overflow-y-auto px-1.5 pb-1.5 pt-1"
        >
          {filtered.map((model, index) => {
            const price = priceLabel(model)
            const isSelected = chosen.includes(model.id)
            return (
              <button
                key={model.id}
                id={rowId(index)}
                ref={index === highlightIndex ? activeRowRef : undefined}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={isSelected}
                onMouseDown={keepInputFocus}
                onClick={() => toggleModel(model.id)}
                className={cn(
                  'relative flex min-h-[52px] w-full shrink-0 items-center gap-3 rounded-md pl-3.5 pr-3 text-left text-sm transition-colors',
                  isSelected
                    ? 'bg-primary/10 font-medium text-primary'
                    : index === highlightIndex
                      ? 'bg-accent'
                      : 'hover:bg-accent',
                )}
              >
                {isSelected && <span aria-hidden className="absolute bottom-2.5 left-[3px] top-2.5 w-[3px] rounded-sm bg-primary" />}
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate">{displayName(model)}</span>
                    {recommended.includes(model.id) && (
                      // The crown that already marks recommended local models and providers elsewhere in the app.
                      <span
                        role="img"
                        className="inline-flex shrink-0 text-amber-500"
                        title={t('local.recommended')}
                        aria-label={t('local.recommended')}
                      >
                        <Crown className="h-3.5 w-3.5" aria-hidden />
                      </span>
                    )}
                  </span>
                  <span className="block truncate text-xs font-normal leading-4 text-muted-foreground">{model.id}</span>
                </span>
                {price.kind === 'free' && (
                  <span className="shrink-0 text-[13px] font-normal text-success-strong" title={priceTitle(model)}>{t('ai.modelFree')}</span>
                )}
                {price.kind === 'price' && (
                  <span
                    className="flex shrink-0 flex-col items-end text-xs font-normal leading-4 tabular-nums text-muted-foreground"
                    title={priceTitle(model)}
                  >
                    <span className="flex gap-1"><span className="text-muted-foreground/80">{t('ai.modelPriceIn')}</span><span>{price.input}</span></span>
                    <span className="flex gap-1"><span className="text-muted-foreground/80">{t('ai.modelPriceOut')}</span><span>{price.output}</span></span>
                  </span>
                )}
              </button>
            )
          })}
          {customId && (
            <button
              id={rowId(filtered.length)}
              ref={filtered.length === highlightIndex ? activeRowRef : undefined}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={false}
              onMouseDown={keepInputFocus}
              onClick={commitTyped}
              className={cn(
                'flex min-h-[44px] w-full shrink-0 items-center gap-2 rounded-md px-3.5 text-left text-sm transition-colors',
                filtered.length === highlightIndex ? 'bg-accent' : 'hover:bg-accent',
              )}
            >
              <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 truncate">{t('ai.modelAddCustom', { model: customId })}</span>
            </button>
          )}
        </div>
      )}
    </div>,
    document.body,
  ) : null

  // The panel is a sibling of the field, not a child: React synthetic events bubble through portals,
  // so a child panel would feed its own mousedown to the field's handler below.
  return (
    <>
      <div
        ref={fieldRef}
        onMouseDown={(event) => {
          // Clicks on the padding or the chips' gaps focus the input; buttons and the input itself behave natively.
          const target = event.target as HTMLElement
          if (disabled || target === inputRef.current || target.closest('button')) return
          event.preventDefault()
          inputRef.current?.focus({ preventScroll: true })
          openPanel(true)
        }}
        className={cn(
          'flex w-full cursor-text items-center rounded-md border border-input-border bg-input-bg text-sm transition-colors',
          multiple ? 'min-h-9 flex-wrap gap-1.5 py-1 pl-2 pr-1' : 'h-9 pl-3 pr-1',
          'hover:border-muted-foreground/40 focus-within:border-input-focus-border focus-within:ring-2 focus-within:ring-input-focus-ring/20',
          disabled && 'cursor-not-allowed opacity-50',
        )}
      >
        {multiple && value.map((id) => (
          <span
            key={id}
            className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-secondary/50 py-0.5 pl-2 pr-1 text-xs"
          >
            <span className="truncate">{id}</span>
            <button
              type="button"
              disabled={disabled}
              onMouseDown={keepInputFocus}
              onClick={() => onRemove(id)}
              aria-label={t('ai.removeModel', { model: id })}
              className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive-strong"
            >
              <X className="h-3 w-3" aria-hidden />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={inputId}
          type="text"
          role={hasCatalog ? 'combobox' : undefined}
          aria-expanded={hasCatalog ? panelOpen : undefined}
          aria-haspopup={hasCatalog ? 'listbox' : undefined}
          aria-controls={panelOpen && optionCount > 0 ? listId : undefined}
          aria-autocomplete={hasCatalog ? 'list' : undefined}
          aria-activedescendant={panelOpen && highlightIndex >= 0 ? rowId(highlightIndex) : undefined}
          autoComplete="off"
          spellCheck={false}
          value={inputValue}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(event) => handleInputChange(event.target.value)}
          onKeyDown={handleInputKeyDown}
          onClick={() => openPanel(true)}
          className={cn(
            'flex-1 bg-transparent text-sm text-foreground placeholder:text-input-placeholder focus:outline-none disabled:cursor-not-allowed',
            multiple ? 'min-w-[8rem] py-0.5' : 'min-w-0',
          )}
        />
        {hasCatalog && (
          <button
            type="button"
            tabIndex={-1}
            disabled={disabled}
            aria-label={t('ai.modelListToggle')}
            aria-expanded={panelOpen}
            onMouseDown={keepInputFocus}
            onClick={togglePanel}
            className="ml-auto rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ChevronDown className={cn('h-4 w-4 transition-transform', panelOpen && 'rotate-180')} aria-hidden />
          </button>
        )}
      </div>
      {dropdown}
    </>
  )
}

export interface RecommendedModelsProps {
  /** Recommended ids, in display order. */
  models: string[]
  /** Ids already chosen: they are not offered again. */
  chosen: string[]
  onPick: (id: string) => void
  disabled?: boolean
}

/**
 * One-click picks under the model field. It works before the catalog is loaded, which is the point:
 * a new service starts without a model, and recommendations are the quickest way to give it one.
 * The row disappears once every recommendation is chosen. The crown alone labels the picks and its
 * tooltip carries the word, matching the recommended marker used across the app.
 */
export function RecommendedModels({ models, chosen, onPick, disabled = false }: RecommendedModelsProps) {
  const t = useT()
  const offered = models.filter((id) => !chosen.includes(id))
  if (offered.length === 0) return null
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
      <Tooltip content={t('local.recommended')}>
        <span
          className="inline-flex shrink-0 cursor-help items-center text-amber-500"
          aria-label={t('local.recommended')}
        >
          <Crown className="h-3 w-3" aria-hidden />
        </span>
      </Tooltip>
      {offered.map((id) => (
        <button
          key={id}
          type="button"
          disabled={disabled}
          onClick={() => onPick(id)}
          className="max-w-full truncate rounded-md border border-border bg-secondary/50 px-2 py-0.5 transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
        >
          {id}
        </button>
      ))}
    </div>
  )
}
