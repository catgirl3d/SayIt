import { Check, ExternalLink, Loader2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Segmented } from '@/components/ui/segmented'
import { useT } from '@/i18n/useT'
import { cn } from '@/lib/utils'
import { HOTWORD_TOKEN_BUDGET } from '@/services/hotwords/budget'
import { BUILTIN_SETS } from '@/services/hotwords/model'
import type { HotwordCatalog } from '@/services/hotwords/settings'
import type { HotwordCategorySelection, HotwordMode, HotwordPlan } from './hotwordPlan'

interface HotwordSectionProps {
  mode: HotwordMode
  onModeChange: (mode: HotwordMode) => void
  selection: HotwordCategorySelection
  onSelectionChange: (selection: HotwordCategorySelection) => void
  catalog: HotwordCatalog | null
  catalogError: string
  plan: HotwordPlan
  disabled?: boolean
  onRetry: () => void
}

interface CategoryRowProps {
  label: string
  wordCount: number
  checked: boolean
  disabled?: boolean
  onToggle: () => void
}

function CategoryRow({ label, wordCount, checked, disabled, onToggle }: CategoryRowProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs outline-none transition-colors',
        'focus-visible:ring-2 focus-visible:ring-ring',
        checked ? 'bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
        'disabled:pointer-events-none disabled:opacity-50',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border',
          checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input-border',
        )}
      >
        {checked && <Check className="h-3 w-3" />}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">{wordCount}</span>
    </button>
  )
}

/**
 * Per-job hotwords source for the Files page. Each file starts without hotwords; turning the
 * dictionary on either uses the active dictionary from dictation or replaces it for this run
 * without changing the global one. The page renders this section only when the engine and
 * provider use hotwords; every remaining condition that would keep them from being sent is
 * stated here.
 */
export default function HotwordSection({
  mode,
  onModeChange,
  selection,
  onSelectionChange,
  catalog,
  catalogError,
  plan,
  disabled,
  onRetry,
}: HotwordSectionProps) {
  const t = useT()
  const builtinCategories = catalog
    ? Object.entries(BUILTIN_SETS)
        .map(([key, set]) => ({ key, label: set.label, wordCount: (catalog.builtinSetWords[key] ?? []).length }))
        .filter((category) => category.wordCount > 0)
    : []
  const customCategories = catalog?.customThemes.filter((theme) => theme.words.length > 0) ?? []

  const toggleBuiltin = (key: string) => {
    const selected = selection.builtinKeys.includes(key)
    onSelectionChange({
      ...selection,
      builtinKeys: selected ? selection.builtinKeys.filter((item) => item !== key) : [...selection.builtinKeys, key],
    })
  }

  const toggleTheme = (id: string) => {
    const selected = selection.themeIds.includes(id)
    onSelectionChange({
      ...selection,
      themeIds: selected ? selection.themeIds.filter((item) => item !== id) : [...selection.themeIds, id],
    })
  }

  const summary =
    mode === 'none'
      ? t('files.hotwordsNoneSummary')
      : t(mode === 'active' ? 'files.hotwordsActiveSummary' : 'files.hotwordsSelectedSummary', {
          count: plan.wordCount,
        })

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span id="file-hotwords-label" className="text-xs font-medium text-foreground">
          {t('files.hotwordsTitle')}
        </span>
        <Link
          to="/hotwords"
          className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          {t('files.hotwordsOpenDictionary')}
        </Link>
      </div>
      <Segmented
        size="sm"
        labelledBy="file-hotwords-label"
        value={mode}
        disabled={disabled}
        onChange={onModeChange}
        options={[
          { value: 'active', label: t('files.hotwordsModeActive') },
          { value: 'selected', label: t('files.hotwordsModeSelected') },
          { value: 'none', label: t('files.hotwordsModeNone') },
        ]}
      />

      {mode === 'none' ? (
        <p className="text-xs text-muted-foreground">{summary}</p>
      ) : catalogError ? (
        <div className="space-y-1.5">
          <p role="alert" className="text-xs text-destructive">
            {t('files.hotwordsLoadFailed')}: {catalogError}
          </p>
          <button
            type="button"
            disabled={disabled}
            onClick={onRetry}
            className="rounded text-xs font-medium text-primary underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          >
            {t('common.retry')}
          </button>
        </div>
      ) : !catalog ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('files.hotwordsLoading')}
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{summary}</p>
          {plan.notices.includes('deepgramGate') && (
            <p className="text-xs leading-relaxed text-warning-strong">
              {t('hotwords.deepgramGate', { option: t('asr.deepgramKeyterms') })}{' '}
              <Link to="/voice-engine" className="inline-flex items-center gap-0.5 underline underline-offset-2">
                {t('common.openVoiceEngine')}
                <ExternalLink className="h-3 w-3" />
              </Link>
            </p>
          )}
          {plan.notices.includes('deepgramTokenBudget') && (
            <p className="text-xs leading-relaxed text-warning-strong">
              {t('hotwords.deepgramBudget', {
                tokens: plan.tokenEstimate,
                budget: HOTWORD_TOKEN_BUDGET,
              })}
            </p>
          )}
          {plan.notices.includes('wordCap') && plan.wordCapLimit !== null && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t('hotwords.wordCap', { wordBudget: plan.wordCapLimit })}
            </p>
          )}
          {mode === 'selected' && (
            <div className="max-h-56 space-y-0.5 overflow-auto pr-1">
              {builtinCategories.map((category) => (
                <CategoryRow
                  key={category.key}
                  label={category.label}
                  wordCount={category.wordCount}
                  checked={selection.builtinKeys.includes(category.key)}
                  disabled={disabled}
                  onToggle={() => toggleBuiltin(category.key)}
                />
              ))}
              {customCategories.map((theme) => (
                <CategoryRow
                  key={theme.id}
                  label={theme.name}
                  wordCount={theme.words.length}
                  checked={selection.themeIds.includes(theme.id)}
                  disabled={disabled}
                  onToggle={() => toggleTheme(theme.id)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
