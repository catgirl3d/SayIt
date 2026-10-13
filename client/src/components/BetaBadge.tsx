import { cn } from '@/lib/utils'
import { useT } from '@/i18n/useT'

/**
 * "Beta" marker for features that are still settling down. Shared by the sidebar entry and the
 * computer-subtitles page heading so the two markers cannot drift apart; callers adjust only the
 * size through className.
 */
export default function BetaBadge({ className }: { className?: string }) {
  const t = useT()
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase leading-none tracking-wide text-red-600 dark:text-red-400',
        className,
      )}
    >
      {t('common.beta')}
    </span>
  )
}
