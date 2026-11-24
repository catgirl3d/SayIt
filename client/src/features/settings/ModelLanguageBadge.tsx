import { useState, useRef, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Languages, ChevronDown, Check, CheckCircle2, AlertCircle, Search, X } from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import { usePopover } from '@/hooks/usePopover'
import { t } from '@/i18n'
import { useLocale, useT } from '@/i18n/useT'
import type { PlacementOptions } from '@/lib/popoverPlacement'
import { getLanguageDisplayName, resolveModelLanguages } from '@/lib/languageNames'

interface ModelLanguageBadgeProps {
  model: {
    id: string
    name: string
    languages?: string[]
    languages_label?: string
  }
  badgeLanguage: string
}

// Opens below the trigger, aligned to its left edge; flips above when there is no room below.
const BADGE_POPOVER_PLACEMENT: PlacementOptions = { align: 'start', gap: 6, viewportMargin: 10 }

export function ModelLanguageBadge({ model, badgeLanguage }: ModelLanguageBadgeProps) {
  useT()
  const locale = useLocale()
  const [isOpen, setIsOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const { panelRef, panelStyle } = usePopover({
    open: isOpen,
    onDismiss: () => setIsOpen(false),
    anchorRef: triggerRef,
    returnFocusRef: triggerRef,
    placement: BADGE_POPOVER_PLACEMENT,
  })
  const searchInputRef = useRef<HTMLInputElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  const languages = model.languages ?? []
  const hasLanguages = languages.length > 0

  const resolvedLanguages = useMemo(
    () => resolveModelLanguages(languages, badgeLanguage, locale),
    [languages, badgeLanguage, locale],
  )

  const supportsCurrent = useMemo(
    () => languages.includes(badgeLanguage),
    [languages, badgeLanguage],
  )

  const currentLanguageName = useMemo(
    () => getLanguageDisplayName(badgeLanguage, locale),
    [badgeLanguage, locale],
  )
  // Filter languages in popover when search query is entered
  const filteredLanguages = useMemo(() => {
    const q = searchQuery.toLowerCase().trim()
    if (!q) return resolvedLanguages
    return resolvedLanguages.filter(
      (item) => item.name.toLowerCase().includes(q) || item.code.toLowerCase().includes(q),
    )
  }, [resolvedLanguages, searchQuery])

  // Reset search and focus the first useful control on open
  useEffect(() => {
    if (isOpen) {
      setSearchQuery('')
      // Small timeout to allow portal mounting
      const timer = setTimeout(() => {
        if (searchInputRef.current) {
          searchInputRef.current.focus()
        } else {
          closeButtonRef.current?.focus()
        }
      }, 50)
      return () => clearTimeout(timer)
    }
  }, [isOpen])

  // Informative tooltip text for hover state
  const tooltipText = useMemo(() => {
    if (languages.length === 1) {
      const name = resolvedLanguages[0]?.name || languages[0]
      return supportsCurrent
        ? t('local.langSupportedDetail', { lang: name })
        : t('local.langUnsupportedDetail', { lang: currentLanguageName })
    }
    if (languages.length <= 3) {
      const names = resolvedLanguages.map((l) => l.name).join(', ')
      return supportsCurrent
        ? `${t('local.langSupportedDetail', { lang: currentLanguageName })} (${names})`
        : `${t('local.langUnsupportedDetail', { lang: currentLanguageName })} (${names})`
    }
    return supportsCurrent
      ? `${t('local.langSupportedDetail', { lang: currentLanguageName })} · ${t('local.languagesTotalCount', { count: languages.length })}`
      : `${t('local.langUnsupportedDetail', { lang: currentLanguageName })} · ${t('local.languagesTotalCount', { count: languages.length })}`
  }, [languages, resolvedLanguages, supportsCurrent, currentLanguageName, locale])

  if (!hasLanguages) {
    return model.languages_label ? <span>{model.languages_label}</span> : null
  }

  return (
    <>
      <Tooltip content={isOpen ? null : tooltipText}>
        <button
          ref={triggerRef}
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setIsOpen((prev) => !prev)
          }}
          className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
            supportsCurrent
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20'
              : 'border-border/80 bg-muted/40 text-muted-foreground hover:bg-accent hover:text-foreground'
          }`}
          aria-expanded={isOpen}
          aria-haspopup="dialog"
          aria-label={t('local.languagesTitle', { count: languages.length })}
        >
          <Languages className="h-3.5 w-3.5" aria-hidden />
          <span>({languages.length})</span>
          {languages.length > 1 && (
            <ChevronDown
              className={`h-3 w-3 transition-transform ${
                supportsCurrent
                  ? 'text-emerald-600/70 dark:text-emerald-400/70'
                  : 'opacity-60'
              } ${isOpen ? 'rotate-180' : ''}`}
              aria-hidden
            />
          )}
        </button>
      </Tooltip>

      {isOpen &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={t('local.languagesTitle', { count: languages.length })}
            className="fixed z-[9999] w-80 rounded-lg border border-border bg-popover p-3 shadow-xl sm:w-96"
            style={panelStyle}
          >
            {/* Header */}
            <div className="flex items-center justify-between gap-2 border-b border-border/60 pb-2">
              <div className="flex items-center gap-1.5 min-w-0">
                <Languages className="h-4 w-4 text-primary shrink-0" aria-hidden />
                <span className="text-xs font-semibold truncate text-foreground">
                  {t('local.languagesTitle', { count: languages.length })}
                </span>
                <span className="text-[11px] text-muted-foreground truncate">
                  ({model.name})
                </span>
              </div>
              <button
                ref={closeButtonRef}
                type="button"
                onClick={() => {
                  setIsOpen(false)
                  triggerRef.current?.focus()
                }}
                className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                aria-label={t('common.close')}
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>

            {/* Compatibility alert */}
            <div className="my-2.5">
              {supportsCurrent ? (
                <div className="flex items-center gap-2 rounded-md bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-700 dark:text-emerald-300">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="leading-snug">
                    {t('local.langSupportedDetail', { lang: currentLanguageName })}
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-2 rounded-md bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-300">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="leading-snug">
                    {t('local.langUnsupportedDetail', { lang: currentLanguageName })}
                  </span>
                </div>
              )}
            </div>

            {/* Quick search (shown when more than 10 languages) */}
            {languages.length > 10 && (
              <div className="relative mb-2">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t('local.searchLanguagePlaceholder')}
                  className="w-full rounded-md border border-input bg-background py-1 pl-8 pr-3 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
            )}

            {/* Scrollable list of language chips */}
            <div className="max-h-48 overflow-y-auto pr-1">
              {filteredLanguages.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {filteredLanguages.map((item) => (
                    <span
                      key={item.code}
                      className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs ${
                        item.isCurrent
                          ? 'bg-emerald-500/15 font-medium text-emerald-700 ring-1 ring-emerald-500/30 dark:text-emerald-300'
                          : 'bg-muted/70 text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {item.isCurrent && <Check className="h-2.5 w-2.5 text-emerald-600" aria-hidden />}
                      <span>{item.name}</span>
                      <span className="text-[10px] opacity-60 uppercase">({item.code})</span>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="py-3 text-center text-xs text-muted-foreground">
                  {t('local.noLanguagesFound')}
                </p>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
