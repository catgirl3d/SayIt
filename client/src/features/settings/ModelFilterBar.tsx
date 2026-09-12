import { Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import type { ModelFilterTab } from './modelFilter'

interface ModelFilterBarProps {
  tab: ModelFilterTab
  onTabChange: (tab: ModelFilterTab) => void
  searchQuery: string
  onSearchQueryChange: (query: string) => void
  totalCount: number
  downloadedCount: number
}

export function ModelFilterBar({
  tab,
  onTabChange,
  searchQuery,
  onSearchQueryChange,
  totalCount,
  downloadedCount,
}: ModelFilterBarProps) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2.5">
      <div
        role="tablist"
        aria-label={t('local.modelTitle')}
        className="flex items-center gap-1 rounded-lg border border-border/80 bg-muted/30 p-1"
      >
        <button
          type="button"
          role="tab"
          id="model-filter-tab-all"
          aria-selected={tab === 'all'}
          aria-controls="model-catalog-list"
          onClick={() => onTabChange('all')}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
            tab === 'all'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <span>{t('local.filterAll')}</span>
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {totalCount}
          </span>
        </button>
        <button
          type="button"
          role="tab"
          id="model-filter-tab-downloaded"
          aria-selected={tab === 'downloaded'}
          aria-controls="model-catalog-list"
          onClick={() => onTabChange('downloaded')}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors ${
            tab === 'downloaded'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <span>{t('local.filterDownloaded')}</span>
          <span
            className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
              downloadedCount > 0
                ? 'bg-success/15 text-success-strong'
                : 'bg-muted text-muted-foreground'
            }`}
          >
            {downloadedCount}
          </span>
        </button>
      </div>

      <div className="relative min-w-[180px] flex-1 sm:max-w-xs sm:flex-initial">
        <Search
          className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchQueryChange(e.target.value)}
          placeholder={t('local.searchPlaceholder')}
          aria-label={t('local.searchPlaceholder')}
          className="w-full rounded-md border border-input-border bg-input-bg py-1 pl-8 pr-7 text-xs text-foreground placeholder:text-muted-foreground focus:border-input-focus-border focus:outline-none"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => onSearchQueryChange('')}
            aria-label={t('common.close')}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

interface ModelFilterEmptyStateProps {
  tab: ModelFilterTab
  downloadedCount: number
  searchQuery: string
  onSwitchToAll: () => void
  onClearFilters: () => void
}

export function ModelFilterEmptyState({
  tab,
  downloadedCount,
  searchQuery,
  onSwitchToAll,
  onClearFilters,
}: ModelFilterEmptyStateProps) {
  return (
    <div className="rounded-lg border border-dashed border-border py-8 text-center">
      {tab === 'downloaded' && downloadedCount === 0 ? (
        <>
          <p className="text-sm font-medium text-foreground">{t('local.noDownloadedModels')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('local.noDownloadedModelsHint')}</p>
          <Button
            size="sm"
            variant="outline"
            className="mt-3"
            onClick={onSwitchToAll}
          >
            {t('local.filterAll')}
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm font-medium text-foreground">
            {t('local.noModelsFound', { query: searchQuery })}
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-3"
            onClick={onClearFilters}
          >
            {t('local.clearFilters')}
          </Button>
        </>
      )}
    </div>
  )
}
