import { useId, useState } from 'react'
import { Check, Plus, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { t } from '@/i18n'

export interface SuggestionSet {
  key: string
  label: string
  words: string[]
}

interface SuggestedTermsPickerProps {
  sets: SuggestionSet[]
  /** Terms the category already has; matched case-insensitively. */
  selected: string[]
  /** Whether a term that is not selected yet still fits the token budget. */
  canAdd: (word: string) => boolean
  onToggle: (word: string) => void
  budgetText: string
}

/**
 * Lets the user build a custom category from the built-in sets: one click adds a term to the
 * category, a second click removes it. Terms that would exceed the token budget are disabled.
 */
export default function SuggestedTermsPicker({ sets, selected, canAdd, onToggle, budgetText }: SuggestedTermsPickerProps) {
  const [activeKey, setActiveKey] = useState(sets[0]?.key ?? '')
  const [query, setQuery] = useState('')
  const baseId = useId()
  const panelId = `${baseId}-panel`
  const tabId = (key: string) => `${baseId}-tab-${key}`
  const selectedLower = new Set(selected.map((word) => word.toLowerCase()))
  const needle = query.trim().toLowerCase()

  const groups = needle
    ? sets
      .map((set) => ({ ...set, words: set.words.filter((word) => word.toLowerCase().includes(needle)) }))
      .filter((set) => set.words.length > 0)
    : sets.filter((set) => set.key === activeKey)

  const isSelected = (word: string) => selectedLower.has(word.toLowerCase())
  const hasBlocked = groups.some((set) => set.words.some((word) => !isSelected(word) && !canAdd(word)))

  const renderChip = (word: string) => {
    const chosen = isSelected(word)
    return (
      <button
        key={word}
        type="button"
        aria-pressed={chosen}
        disabled={!chosen && !canAdd(word)}
        onClick={() => onToggle(word)}
        className={cn(
          'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs transition-colors',
          'disabled:cursor-not-allowed disabled:opacity-40',
          chosen
            ? 'border-primary/50 bg-primary/15 text-foreground'
            : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
      >
        {chosen ? <Check className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
        {word}
      </button>
    )
  }

  return (
    <div className="space-y-2.5 rounded-md border border-border bg-secondary/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium">{t('dict.suggestedTitle')}</p>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('dict.suggestedSearch')}
            aria-label={t('dict.suggestedSearch')}
            className="w-52 rounded-md border border-input-border bg-input-bg py-1 pl-7 pr-2 text-xs"
          />
        </div>
      </div>

      {!needle && (
        <div className="flex flex-wrap gap-1" role="tablist" aria-label={t('dict.suggestedTitle')}>
          {sets.map((set) => (
            <button
              key={set.key}
              id={tabId(set.key)}
              type="button"
              role="tab"
              aria-selected={set.key === activeKey}
              aria-controls={panelId}
              onClick={() => setActiveKey(set.key)}
              className={cn(
                'rounded-md px-2 py-0.5 text-xs transition-colors',
                set.key === activeKey ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {set.label}
            </button>
          ))}
        </div>
      )}

      {/* Search results span every set, so only the unfiltered view is the panel of the selected tab. */}
      <div
        className="space-y-2.5"
        {...(needle ? {} : { id: panelId, role: 'tabpanel', 'aria-labelledby': tabId(activeKey) })}
      >
        {groups.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('dict.suggestedNoMatch')}</p>
        ) : (
          groups.map((set) => (
            <div key={set.key} className="space-y-1.5">
              {needle && <p className="text-xs text-muted-foreground">{set.label}</p>}
              <div className="flex flex-wrap gap-1.5">{set.words.map(renderChip)}</div>
            </div>
          ))
        )}
      </div>

      {hasBlocked && <p className="text-xs text-amber-500">{t('dict.suggestedBlocked')}</p>}
      <p className="text-xs text-muted-foreground">{budgetText}</p>
    </div>
  )
}
