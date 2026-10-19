import { useEffect, useState } from 'react'
import { Plus, X, Search, RotateCcw, ChevronDown, ChevronUp, FolderPlus, Trash2, Download, Info, Sparkles, CopyPlus, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { exportHotwords } from '@/services/exports'
import { HOTWORD_TOKEN_BUDGET, HOTWORD_WORD_BUDGET } from '@/services/hotwords/budget'
import { loadDictationHotwordEngine, type DictationHotwordEngine } from '@/services/hotwords/activeEngine'
import { loadAsrHotwordCapabilityMatrix } from '@/services/hotwords/capabilityMatrix'
import { BUILTIN_SETS, MAX_HOTWORDS } from '@/services/hotwords/model'
import { useHotwordsManager } from '@/services/hotwords/useHotwordsManager'
import SuggestedTermsPicker from '@/components/SuggestedTermsPicker'
import TextReplacementSection from '@/components/TextReplacementSection'
import TextFormatSection from '@/components/TextFormatSection'
import { useSortable, DragHandle } from '@/components/ui/sortable'
import { t } from '@/i18n'
import { RichText } from '@/i18n/RichText'
import { useT } from '@/i18n/useT'
import { ASR_PROVIDERS, findAsrProvider } from '@/features/settings/asrProviderCatalog'
import {
  foldHotwordDelivery,
  hotwordCapabilityNoteKey,
  type AsrHotwordCapability,
  type FoldedHotwordDelivery,
  type HotwordCapabilityNoteKey,
} from '@/lib/asrModels'

type Tab = 'hotwords' | 'replacement'

interface HotwordCapabilityRow {
  label: string
  status: FoldedHotwordDelivery
  clientCap: number | null
  noteKey: HotwordCapabilityNoteKey | null
}

function capabilityLabels(provider: string): string[] {
  if (provider === 'server') return [t('mode.server')]
  if (provider === 'local') return [t('mode.local')]
  if (provider === 'doubao') return [findAsrProvider('doubao_v2')?.label ?? provider]
  if (provider === 'aliyun') return [findAsrProvider('qwen')?.label ?? provider]
  if (provider === 'qwen_omni') {
    return ASR_PROVIDERS
      .filter(({ id }) => id.startsWith('qwen_omni_'))
      .map(({ label }) => label)
  }
  return [findAsrProvider(provider)?.label ?? provider]
}

function buildHotwordCapabilityRows(
  matrix: Record<string, AsrHotwordCapability>,
): HotwordCapabilityRow[] {
  const grouped = new Map<string, HotwordCapabilityRow>()

  for (const [provider, capability] of Object.entries(matrix)) {
    const status = foldHotwordDelivery(capability.delivery)
    const noteKey = hotwordCapabilityNoteKey(provider)
    for (const label of capabilityLabels(provider)) {
      const key = JSON.stringify([label, status, capability.clientCap, noteKey])
      if (!grouped.has(key)) {
        grouped.set(key, { label, status, clientCap: capability.clientCap, noteKey })
      }
    }
  }

  return [...grouped.values()].sort((a, b) => a.label.localeCompare(b.label))
}

/** Above this total hotword count, show a soft hint that too many terms can counterintuitively lower accuracy. */
const HOTWORD_SOFT_LIMIT = 200
/**
 * When one category holds more terms than this, collapse it: show only the first N plus an
 * expand button, so a single category does not spread out as a flat wall of chips.
 */
const CHIPS_COLLAPSE_LIMIT = 30

/** Term chip list. It collapses when there are many terms; searching does not collapse it, so matching items are never hidden. */
function WordChips({
  words,
  onRemove,
  expandAll = false,
}: {
  words: string[]
  onRemove: (word: string) => void
  expandAll?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const overflow = words.length > CHIPS_COLLAPSE_LIMIT
  const shown = expanded || expandAll || !overflow ? words : words.slice(0, CHIPS_COLLAPSE_LIMIT)

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {shown.map((word) => (
          <span
            key={word}
            className="inline-flex items-center gap-1 rounded-md border bg-secondary/50 px-2 py-0.5 text-xs"
          >
            {word}
            <button
              onClick={() => onRemove(word)}
              className="rounded-full p-0.5 transition-colors hover:bg-destructive/10 hover:text-destructive"
              aria-label={t('dict.deleteWord', { word })}
            >
              <X className="h-2.5 w-2.5 text-muted-foreground" />
            </button>
          </span>
        ))}
      </div>
      {overflow && !expandAll && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded ? t('dict.collapse') : t('dict.expandAll', { count: words.length })}
        </button>
      )}
    </div>
  )
}

export default function Dictionary() {
  useT()
  const [hotwordCapabilities, setHotwordCapabilities] = useState<Record<string, AsrHotwordCapability>>({})
  const [hotwordCapabilityLoadFailed, setHotwordCapabilityLoadFailed] = useState(false)
  const [dictationEngine, setDictationEngine] = useState<DictationHotwordEngine | null>(null)
  const [tab, setTab] = useState<Tab>('hotwords')
  const [exportMessage, setExportMessage] = useState('')
  const [warnDismissed, setWarnDismissed] = useState(false)
  const {
    hotwords,
    builtinSetWords,
    builtinSetActive,
    customThemes,
    customThemeActive,
    themeInputs,
    newThemeName,
    search,
    loading,
    showUnknown,
    hotwordTokens,
    builtinSetBlocked,
    customThemeBlocked,
    builtinSetCopyable,
    filtered,
    filteredUnknown,
    visibleCustomThemes,
    getSetWordsInHotwords,
    getThemeWordsInHotwords,
    setNewThemeName,
    setSearch,
    setShowUnknown,
    setThemeInput,
    addTheme,
    addWordsToTheme,
    removeTheme,
    moveTheme,
    toggleCustomTheme,
    removeWordFromTheme,
    removeWordFromBuiltinSet,
    removeLegacyWord,
    canAddSuggestedTerm,
    toggleSuggestedTerm,
    toggleBuiltinSet,
    resetBuiltinSet,
    copyBuiltinSetToTheme,
  } = useHotwordsManager()
  // Only one category shows the suggested-terms picker at a time.
  const [pickerThemeId, setPickerThemeId] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    void loadAsrHotwordCapabilityMatrix()
      .then((matrix) => {
        if (mounted) setHotwordCapabilities(matrix)
      })
      .catch((error: unknown) => {
        if (!mounted) return
        console.warn('Failed to load ASR hotword capability matrix', error)
        setHotwordCapabilityLoadFailed(true)
      })
    return () => { mounted = false }
  }, [])

  useEffect(() => {
    let mounted = true
    void loadDictationHotwordEngine()
      .then((engine) => {
        if (mounted) setDictationEngine(engine)
      })
      .catch((error: unknown) => {
        if (mounted) console.warn('Failed to resolve the dictation engine for the hotword notice', error)
      })
    return () => { mounted = false }
  }, [])

  const capabilityRows = buildHotwordCapabilityRows(hotwordCapabilities)
  // The verdict is the Rust matrix entry of the engine dictation uses; the notice stays hidden until
  // both the matrix and the engine have resolved, and for engines the matrix does not know.
  const engineCapability = dictationEngine ? hotwordCapabilities[dictationEngine.capabilityKey] : undefined
  const engineIgnoresHotwords = engineCapability !== undefined
    && foldHotwordDelivery(engineCapability.delivery) === 'not_sent'
  const engineLabel = dictationEngine === null
    ? ''
    : dictationEngine.mode === 'cloud_api'
      ? dictationEngine.providerLabel
      : t(dictationEngine.mode === 'local' ? 'mode.local' : 'mode.server')
  const tokensNearBudget = hotwordTokens >= HOTWORD_TOKEN_BUDGET * 0.8
  const tokensOverBudget = hotwordTokens > HOTWORD_TOKEN_BUDGET
  // "Full" is at-or-over the budget: no further preset can be added even with zero new tokens.
  const tokensFull = hotwordTokens >= HOTWORD_TOKEN_BUDGET
  const budgetText = t('dict.budgetLabel', {
    tokens: hotwordTokens,
    tokenBudget: HOTWORD_TOKEN_BUDGET,
    words: hotwords.length,
    wordBudget: HOTWORD_WORD_BUDGET,
  })
  // Suggestions always offer a set's full default list, even after terms were removed from the set.
  const suggestionSets = Object.entries(BUILTIN_SETS).map(([key, setDef]) => ({
    key,
    label: setDef.label,
    words: setDef.words,
  }))

  // While searching, the list is filtered and its indices no longer match the full list, so drag-and-drop is disabled in the search state
  const themeSortable = useSortable({ onMove: (from, to) => void moveTheme(from, to) })

  const handleExport = async () => {
    const result = await exportHotwords()
    setExportMessage(result.canceled ? t('history.exportCanceled') : t('history.savedTo', { path: result.filePath ?? '' }))
  }

  return (
    <div className="mx-auto max-w-4xl">
      {/* Title bar and tabs */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <h1 className="text-2xl font-bold">{t('nav.hotwords')}</h1>
          <div className="flex gap-1 rounded-lg border border-border p-0.5">
            <button
              type="button"
              onClick={() => setTab('hotwords')}
              className={cn(
                'rounded-md px-3 py-1 text-xs transition-colors',
                tab === 'hotwords' ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >{t('dict.tabHotwords')}</button>
            <button
              type="button"
              onClick={() => setTab('replacement')}
              className={cn(
                'rounded-md px-3 py-1 text-xs transition-colors',
                tab === 'replacement' ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >{t('dict.tabTextProcess')}</button>
          </div>
        </div>

        {/* Search and export on the hotwords tab */}
        {tab === 'hotwords' && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">
              {hotwords.length} / {MAX_HOTWORDS}
            </span>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('dict.searchPlaceholder')}
                className="w-52 rounded-md border border-input-border bg-input-bg py-1.5 pl-8 pr-3 text-sm"
              />
            </div>
            <Tooltip content={t('history.export')}>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
                onClick={() => void handleExport()}
                aria-label={t('history.export')}
              >
                <Download className="h-4 w-4" />
              </Button>
            </Tooltip>
          </div>
        )}
      </div>

      {exportMessage && tab === 'hotwords' && (
        <p className="mb-2 text-sm text-muted-foreground">{exportMessage}</p>
      )}

      {/* ===== Text processing tab ===== */}
      {tab === 'replacement' && (
        <>
          <TextFormatSection />
          <TextReplacementSection />
        </>
      )}

      {/* ===== Hotwords tab ===== */}
      {tab === 'hotwords' && (
        <>
          <p className="mb-4 flex items-center gap-1.5 text-sm text-muted-foreground">
            <span>{t('dict.intro')}</span>
            <Tooltip
              variant="light"
              content={
                <div className="text-left">
                  <p className="mb-1.5 font-medium">{t('dict.supportTitle')}</p>
                  {hotwordCapabilityLoadFailed ? (
                    <p className="max-w-[380px] text-xs leading-relaxed">{t('dict.support.loadFailed')}</p>
                  ) : (
                    <table className="border-collapse text-xs [&_td]:py-0.5 [&_td]:pr-3 [&_td]:align-top [&_th]:pb-1 [&_th]:pr-3 [&_th]:text-left [&_th]:font-normal [&_th]:text-muted-foreground/70">
                      <thead>
                        <tr><th>{t('dict.tableModel')}</th><th>{t('dict.tableHotword')}</th><th>{t('dict.tableNote')}</th></tr>
                      </thead>
                      <tbody>
                        {capabilityRows.map(({ label, status, clientCap, noteKey }) => {
                          const notes: string[] = []
                          if (clientCap !== null) notes.push(t('dict.note.clientCap', { count: clientCap }))
                          if (noteKey !== null) notes.push(t(noteKey))
                          return (
                            <tr key={`${label}:${status}:${clientCap ?? ''}:${noteKey ?? ''}`}>
                              <td>{label}</td>
                              <td>{status === 'sent'
                                ? t('dict.support.yes')
                                : status === 'not_sent'
                                  ? t('dict.support.no')
                                  : t('dict.support.unknown')}</td>
                              <td>{notes.join('; ')}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  )}
                  <p className="mt-2 max-w-[380px] leading-relaxed">
                    <RichText text={t('dict.caveat')} />
                  </p>
                </div>
              }
            >
              <Info className="h-3.5 w-3.5 shrink-0 cursor-help text-muted-foreground/50 transition-colors hover:text-muted-foreground" />
            </Tooltip>
          </p>

          {engineIgnoresHotwords && (
            <div
              role="status"
              className="mb-4 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-xs leading-relaxed text-warning-strong"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <p className="min-w-0">
                <RichText
                  text={t('dict.engineIgnores', {
                    engine: engineLabel,
                    toggle: t('hotwordInject.title'),
                    page: t('nav.aiInstructions'),
                  })}
                />
              </p>
            </div>
          )}

          {!loading && (
            <div className="mb-4 -mt-2 space-y-1.5">
              <div className="flex items-center gap-1.5 text-xs">
                <span className={cn(
                  tokensOverBudget ? 'text-destructive' : tokensNearBudget ? 'text-amber-500' : 'text-muted-foreground',
                )}>
                  {budgetText}
                </span>
                <Tooltip
                  variant="light"
                  content={
                    <div className="text-left">
                      <p className="max-w-[380px] text-xs leading-relaxed">{t('dict.budgetTooltipApprox')}</p>
                      <p className="mt-1.5 max-w-[380px] text-xs leading-relaxed">
                        {t('dict.budgetTooltipDeepgram', { tokenBudget: HOTWORD_TOKEN_BUDGET })}
                      </p>
                      <p className="mt-1.5 max-w-[380px] text-xs leading-relaxed">
                        {t('dict.budgetTooltipWords', { wordBudget: HOTWORD_WORD_BUDGET })}
                      </p>
                      <p className="mt-1.5 max-w-[380px] text-xs leading-relaxed">{t('dict.budgetTooltipOrder')}</p>
                    </div>
                  }
                >
                  <Info className="h-3.5 w-3.5 shrink-0 cursor-help text-muted-foreground/50 transition-colors hover:text-muted-foreground" />
                </Tooltip>
              </div>
              <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    'h-full rounded-full transition-[width]',
                    tokensOverBudget ? 'bg-destructive' : tokensNearBudget ? 'bg-amber-500' : 'bg-primary/60',
                  )}
                  style={{ width: `${Math.min(100, (hotwordTokens / HOTWORD_TOKEN_BUDGET) * 100)}%` }}
                />
              </div>
              {hotwords.length > HOTWORD_WORD_BUDGET && (
                <p className="text-xs text-amber-500">
                  {t('dict.budgetWordCap', { wordBudget: HOTWORD_WORD_BUDGET })}
                </p>
              )}
            </div>
          )}

          {hotwords.length > HOTWORD_SOFT_LIMIT && !warnDismissed && (
            <div className="mb-4 -mt-2 flex items-start gap-2 text-xs text-amber-500">
              <p>
                <RichText text={t('dict.countHint', { count: hotwords.length })} />
              </p>
              <button
                type="button"
                onClick={() => setWarnDismissed(true)}
                className="shrink-0 rounded p-0.5 text-amber-500/70 transition-colors hover:bg-amber-500/10 hover:text-amber-500"
                aria-label={t('dict.dismissHint')}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}

          {/* New hotword category */}
          <div className="mb-4 flex items-center gap-2">
            <FolderPlus className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              value={newThemeName}
              onChange={(e) => setNewThemeName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void addTheme()
                }
              }}
              placeholder={t('dict.newCategoryPlaceholder')}
              className="flex-1 rounded-md border border-input-border bg-input-bg px-3 py-1.5 text-sm"
            />
            <Button
              onClick={() => void addTheme()}
              size="sm"
              variant="outline"
              disabled={!newThemeName.trim()}
              className="shrink-0 gap-1.5"
            >
              <Plus className="h-3.5 w-3.5" />
              {t('dict.add')}
            </Button>
          </div>

          {loading ? (
            <p className="py-8 text-center text-muted-foreground">{t('dict.loading')}</p>
          ) : (
            <div className="space-y-4">
              {/* Custom categories */}
              {customThemes.length > 1 && !search && (
                <p className="text-xs text-muted-foreground/70">
                  {t('dict.orderHint')}
                </p>
              )}
              {visibleCustomThemes.map((theme, themeIndex) => {
                const canSort = !search && customThemes.length > 1
                const active = !!customThemeActive[theme.id]
                const blocked = !!customThemeBlocked[theme.id]
                const activeWords = getThemeWordsInHotwords(theme)
                const totalWords = theme.words.length

                return (
                  <Card
                    key={theme.id}
                    {...(canSort ? themeSortable.rowProps(themeIndex) : {})}
                    className={cn('group', !active && 'border-dashed opacity-70', canSort && themeSortable.rowClassName(themeIndex))}
                  >
                    <CardContent className="p-4">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          {canSort && <DragHandle {...themeSortable.handleProps(themeIndex, t('dict.dragCategory', { name: theme.name }))} />}
                          <Switch
                            checked={active}
                            onChange={() => void toggleCustomTheme(theme.id)}
                            disabled={blocked}
                            size="sm"
                          />
                          <div className="min-w-0">
                            <p className="text-sm font-medium">{theme.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {t('dict.customCount', { active: activeWords.length, total: totalWords })}
                            </p>
                            {blocked && (
                              <p className="mt-1 text-xs text-amber-500">
                                {tokensFull ? t('dict.budgetFullBlocked') : t('dict.budgetNoFit')}
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center">
                          <Tooltip content={t('dict.deleteCategory')}>
                            <button
                              type="button"
                              onClick={() => void removeTheme(theme.id)}
                              className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                              aria-label={t('dict.deleteTheme', { name: theme.name })}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </Tooltip>
                        </div>
                      </div>

                      {active && (
                        <div className="space-y-3">
                          <div className="flex gap-2">
                            <input
                              value={themeInputs[theme.id] || ''}
                              onChange={(e) => setThemeInput(theme.id, e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                  e.preventDefault()
                                  void addWordsToTheme(theme.id)
                                }
                              }}
                              placeholder={t('dict.addWordsPlaceholder')}
                              className="flex-1 rounded-md border border-input-border bg-input-bg px-3 py-1.5 text-sm"
                            />
                            <Button
                              onClick={() => void addWordsToTheme(theme.id)}
                              size="sm"
                              variant="outline"
                              disabled={!(themeInputs[theme.id] || '').trim()}
                              className="shrink-0 gap-1.5"
                            >
                              <Plus className="h-3.5 w-3.5" />
                              {t('dict.add')}
                            </Button>
                            <Button
                              onClick={() => setPickerThemeId(pickerThemeId === theme.id ? null : theme.id)}
                              size="sm"
                              variant={pickerThemeId === theme.id ? 'secondary' : 'outline'}
                              aria-expanded={pickerThemeId === theme.id}
                              className="shrink-0 gap-1.5"
                            >
                              <Sparkles className="h-3.5 w-3.5" />
                              {t('dict.suggestedOpen')}
                            </Button>
                          </div>

                          {activeWords.length > 0 && (
                            <WordChips
                              words={activeWords}
                              onRemove={(word) => void removeWordFromTheme(theme.id, word)}
                              expandAll={!!search}
                            />
                          )}

                          {pickerThemeId === theme.id && (
                            <SuggestedTermsPicker
                              sets={suggestionSets}
                              selected={theme.words}
                              canAdd={(word) => canAddSuggestedTerm(theme.id, word)}
                              onToggle={(word) => void toggleSuggestedTerm(theme.id, word)}
                              budgetText={budgetText}
                            />
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                )
              })}

              {/* Built-in categories */}
              {Object.entries(BUILTIN_SETS).map(([key, setDef]) => {
                const active = !!builtinSetActive[key]
                const blocked = !!builtinSetBlocked[key]
                const activeWords = getSetWordsInHotwords(key)
                const totalWords = (builtinSetWords[key] || []).length

                if (search && activeWords.length === 0 && !setDef.label.toLowerCase().includes(search.toLowerCase())) {
                  return null
                }

                return (
                  <Card key={key} className={cn(!active && 'border-dashed opacity-70')}>
                    <CardContent className="p-4">
                      <div className="mb-3 flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <Switch
                            checked={active}
                            onChange={() => void toggleBuiltinSet(key)}
                            disabled={blocked}
                            size="sm"
                          />
                          <div className="min-w-0">
                            <p className="text-sm font-medium">{setDef.label}</p>
                            <p className="text-xs text-muted-foreground">
                              {t('dict.builtinCount', { desc: setDef.description, active: activeWords.length, total: totalWords })}
                            </p>
                            {blocked && (
                              <p className="mt-1 text-xs text-amber-500">
                                {tokensFull ? t('dict.budgetFullBlocked') : t('dict.budgetNoFit')}
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <Tooltip content={t('dict.copyPresetHint')}>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 gap-1 px-2 text-xs"
                              disabled={!builtinSetCopyable[key]}
                              onClick={() => void copyBuiltinSetToTheme(key)}
                            >
                              <CopyPlus className="h-3 w-3" /> {t('dict.copyPreset')}
                            </Button>
                          </Tooltip>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 gap-1 px-2 text-xs"
                            onClick={() => void resetBuiltinSet(key)}
                          >
                            <RotateCcw className="h-3 w-3" /> {t('dict.reset')}
                          </Button>
                        </div>
                      </div>

                      {active && activeWords.length > 0 && (
                        <WordChips
                          words={activeWords}
                          onRemove={(word) => void removeWordFromBuiltinSet(key, word)}
                          expandAll={!!search}
                        />
                      )}
                    </CardContent>
                  </Card>
                )
              })}

              {/* Legacy uncategorized terms */}
              {filteredUnknown.length > 0 && (
                <Card>
                  <CardContent className="p-4">
                    <button
                      className="mb-2 flex w-full items-center justify-between text-left"
                      onClick={() => setShowUnknown(!showUnknown)}
                    >
                      <div>
                        <p className="text-sm font-medium">{t('dict.legacyTitle')}</p>
                        <p className="text-xs text-muted-foreground">
                          {t('dict.legacyDesc')}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-muted-foreground">{filteredUnknown.length}</span>
                        {showUnknown ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                      </div>
                    </button>

                    {showUnknown && (
                      <WordChips words={filteredUnknown} onRemove={(word) => void removeLegacyWord(word)} expandAll={!!search} />
                    )}
                  </CardContent>
                </Card>
              )}

              {!search && hotwords.length === 0 && (
                <div className="rounded-lg border border-dashed border-border py-8 text-center">
                  <p className="text-sm text-muted-foreground">
                    {t('dict.empty')}
                  </p>
                </div>
              )}

              {search && filtered.length === 0 && (
                <p className="py-8 text-center text-muted-foreground">{t('dict.noMatch')}</p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
