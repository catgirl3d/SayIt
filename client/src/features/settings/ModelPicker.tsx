// Searchable, sortable model picker for the AI editor.
//
// Why a feature-local component instead of extending components/ui/select.tsx:
// an OpenRouter catalog has ~470 entries with per-model metadata, while the shared
// Select is a deliberately minimal control used elsewhere. The picker needs search,
// sorting, price badges, and keyboard navigation that no other Select consumer asks for.
//
// Escape routing note: the parent Modal closes on Escape via a document-level
// **capture** listener (components/ui/modal.tsx), which runs before any React
// synthetic handler (portals dispatch at the portal container). To keep Escape
// closing only this dropdown, a native window-capture listener is installed while
// the panel is open: it consumes the event before it can reach the document
// listener. See the escape lifecycle effect below.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Search } from 'lucide-react'
import { useT } from '@/i18n/useT'
import { cn } from '@/lib/utils'
import type { RemoteModel } from './aiProviderCatalog'

export type ModelSort = 'name' | 'priceAsc' | 'priceDesc'

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
  models: RemoteModel[]
  value: string
  onChange: (id: string) => void
  placeholder?: string
  /** Associates the trigger with a visible label because a button has no htmlFor. */
  labelledBy?: string
  disabled?: boolean
}

export function ModelPicker({ models, value, onChange, placeholder, labelledBy, disabled = false }: ModelPickerProps) {
  const t = useT()
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<ModelSort>('name')
  const [activeIndex, setActiveIndex] = useState(0)
  const [dropdownStyle, setDropdownStyle] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  /** Attached only to the keyboard-highlighted row, so the effect below can find it. */
  const activeRowRef = useRef<HTMLButtonElement | null>(null)
  /** Set when the panel opens: the first scroll centers the row, later ones only reveal it. */
  const centerActiveRowRef = useRef(false)

  const selected = models.find((model) => model.id === value)
  const filtered = useMemo(() => sortModels(filterModels(models, query), sort), [models, query, sort])
  const highlightIndex = filtered.length === 0 ? -1 : Math.min(activeIndex, filtered.length - 1)
  const panelVisible = dropdownStyle !== null

  const updatePosition = useCallback(() => {
    const el = triggerRef.current
    if (!el) return

    const rect = el.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom - 8
    const spaceAbove = rect.top - 8
    const openUpwards = spaceBelow < 180 && spaceAbove > spaceBelow

    const maxHeight = Math.min(360, Math.max(120, openUpwards ? spaceAbove : spaceBelow))
    const top = openUpwards ? rect.top - maxHeight - 4 : rect.bottom + 4

    setDropdownStyle({
      top,
      left: rect.left,
      width: rect.width,
      maxHeight,
    })
  }, [])

  useLayoutEffect(() => {
    if (isOpen) {
      updatePosition()
      const handleScrollOrResize = () => updatePosition()
      window.addEventListener('resize', handleScrollOrResize)
      window.addEventListener('scroll', handleScrollOrResize, true)
      return () => {
        window.removeEventListener('resize', handleScrollOrResize)
        window.removeEventListener('scroll', handleScrollOrResize, true)
      }
    }
    setDropdownStyle(null)
  }, [isOpen, updatePosition])

  // Escape reaches this dropdown through a window-capture listener because the parent
  // Modal answers Escape on `document` in the capture phase, before any React handler.
  // Consuming the event here closes only the panel and restores focus to the trigger.
  useLayoutEffect(() => {
    if (!isOpen) return
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      event.preventDefault()
      setIsOpen(false)
      triggerRef.current?.focus({ preventScroll: true })
    }
    window.addEventListener('keydown', onWindowKeyDown, true)
    return () => window.removeEventListener('keydown', onWindowKeyDown, true)
  }, [isOpen])

  // Keeps the highlighted row inside the scrolled list: centered when the panel opens (so the
  // current model is visible at once), revealed with the least movement afterwards. The list is
  // scrolled by hand instead of scrollIntoView because that would also scroll the page behind the
  // dialog. Depends on the panel's visibility flag, not on dropdownStyle: that object is replaced on
  // every scroll event (the scroll listener is a capture one, so it also fires for this list) and
  // would drag the list back while the user scrolls it.
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

  useEffect(() => {
    if (!isOpen) return
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return
      setIsOpen(false)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  function togglePicker() {
    if (disabled) return
    if (isOpen) {
      setIsOpen(false)
      return
    }
    setQuery('')
    // The keyboard highlight starts on the current model, so Enter keeps it and the arrows move from it.
    setActiveIndex(Math.max(0, sortModels(models, sort).findIndex((model) => model.id === value)))
    centerActiveRowRef.current = true
    setIsOpen(true)
  }

  function selectModel(id: string) {
    onChange(id)
    setIsOpen(false)
    triggerRef.current?.focus({ preventScroll: true })
  }

  function handlePanelKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (filtered.length === 0) return
      setActiveIndex((index) => (Math.min(index, filtered.length - 1) + 1) % filtered.length)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (filtered.length === 0) return
      setActiveIndex((index) => (Math.min(index, filtered.length - 1) - 1 + filtered.length) % filtered.length)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (highlightIndex >= 0) selectModel(filtered[highlightIndex].id)
    }
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

  const dropdown = isOpen && dropdownStyle ? createPortal(
    <div
      ref={panelRef}
      onKeyDown={handlePanelKeyDown}
      className="fixed z-[9999] flex flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-xl"
      style={{
        top: `${dropdownStyle.top}px`,
        left: `${dropdownStyle.left}px`,
        width: `${dropdownStyle.width}px`,
        maxHeight: `${dropdownStyle.maxHeight}px`,
      }}
    >
      <div className="flex flex-col gap-2 border-b border-border px-1.5 pb-2 pt-1.5">
        {/* The only focus indicator while the panel is open: the trigger drops its own ring (see below). */}
        <label className="flex h-9 items-center gap-2 rounded-md border border-input-border bg-input-bg px-3 transition-colors focus-within:border-input-focus-border">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIndex(0) }}
            placeholder={t('ai.modelSearch')}
            aria-label={t('ai.modelSearch')}
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-input-placeholder focus:outline-none"
          />
        </label>
        <div className="flex items-center gap-2 px-1.5 text-xs">
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
      </div>

      {filtered.length === 0 ? (
        <div className="px-3 py-6 text-center text-sm text-muted-foreground">{t('ai.modelNoMatch')}</div>
      ) : (
        <div ref={listRef} role="listbox" className="relative flex flex-col gap-0.5 overflow-y-auto px-1.5 pb-1.5 pt-1">
          {filtered.map((model, index) => {
            const price = priceLabel(model)
            const isSelected = model.id === value
            return (
              <button
                key={model.id}
                ref={index === highlightIndex ? activeRowRef : undefined}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => selectModel(model.id)}
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
                  <span className="block truncate">{displayName(model)}</span>
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
        </div>
      )}
    </div>,
    document.body,
  ) : null

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={togglePicker}
        disabled={disabled}
        aria-labelledby={labelledBy}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        className={cn(
          'flex h-9 w-full items-center justify-between rounded-md border border-input-border bg-input-bg px-3 text-sm text-foreground transition-colors',
          'hover:border-muted-foreground/40 focus:border-input-focus-border focus:outline-none focus:ring-2 focus:ring-input-focus-ring/20',
          'disabled:cursor-not-allowed disabled:opacity-50',
          // Focus moves to the search field while open, so the trigger shows a neutral open state instead of a second focus ring.
          isOpen && 'border-muted-foreground/40',
        )}
      >
        <span className={cn('truncate', !selected && !value && 'text-input-placeholder')}>
          {selected ? displayName(selected) : value || placeholder || t('ui.selectPlaceholder')}
        </span>
        <ChevronDown
          className={cn(
            'ml-2 h-4 w-4 shrink-0 text-muted-foreground transition-transform',
            isOpen && 'rotate-180',
          )}
        />
      </button>

      {dropdown}
    </div>
  )
}
