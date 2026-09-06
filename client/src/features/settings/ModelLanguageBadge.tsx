import { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Languages, ChevronDown, Check, CheckCircle2, AlertCircle, Search, X } from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import { t } from '@/i18n'
import { useLocale, useT } from '@/i18n/useT'
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

export function ModelLanguageBadge({ model, badgeLanguage }: ModelLanguageBadgeProps) {
  useT()
  const locale = useLocale()
  const [isOpen, setIsOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
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

  // Position popover relative to the trigger and keep it aligned with viewport changes.
  useLayoutEffect(() => {
    if (!isOpen || !triggerRef.current || !popoverRef.current) {
      setPos(null)
      return
    }

    const updatePos = () => {
      if (!triggerRef.current || !popoverRef.current) return
      const tr = triggerRef.current.getBoundingClientRect()
      const pop = popoverRef.current.getBoundingClientRect()

      const viewportPadding = 10

      // Default to placing below the trigger
      let top = tr.bottom + 6
      let left = tr.left

      // If overflowing viewport bottom, place above
      if (top + pop.height > window.innerHeight - viewportPadding) {
        top = tr.top - pop.height - 6
      }

      // Keep the popover header reachable when the trigger is near the viewport edge.
      const maxTop = Math.max(viewportPadding, window.innerHeight - pop.height - viewportPadding)
      top = Math.min(Math.max(top, viewportPadding), maxTop)

      // Clamp horizontal position
      if (left + pop.width > window.innerWidth - viewportPadding) {
        left = window.innerWidth - pop.width - viewportPadding
      }
      if (left < viewportPadding) {
        left = viewportPadding
      }

      setPos({ top, left })
    }

    updatePos()

    let resizeObserver: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(updatePos)
      resizeObserver.observe(popoverRef.current)
    }

    window.addEventListener('resize', updatePos)
    window.addEventListener('scroll', updatePos, true)
    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', updatePos)
      window.removeEventListener('scroll', updatePos, true)
    }
  }, [isOpen, searchQuery])
  // Handle clicking outside and Escape key
  useEffect(() => {
    if (!isOpen) return

    function handlePointerDown(e: MouseEvent) {
      const target = e.target as Node | null
      if (
        popoverRef.current &&
        !popoverRef.current.contains(target) &&
        triggerRef.current &&
        !triggerRef.current.contains(target)
      ) {
        setIsOpen(false)
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setIsOpen(false)
        triggerRef.current?.focus()
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen])

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
            ref={popoverRef}
            role="dialog"
            aria-label={t('local.languagesTitle', { count: languages.length })}
            className="fixed z-[9999] w-80 rounded-lg border border-border bg-card p-3 shadow-xl sm:w-96"
            style={{
              top: pos ? `${pos.top}px` : '-9999px',
              left: pos ? `${pos.left}px` : '-9999px',
            }}
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
