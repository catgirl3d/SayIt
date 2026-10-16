import { cn } from '@/lib/utils'
import { useT } from '@/i18n/useT'

/**
 * Alpha marker for features that are still settling down. Shared by the sidebar entries and the
 * feature page headings so the markers cannot drift apart; callers adjust only the size through
 * className. The glyph is the alpha outline from the marker SVG (its frame is dropped in favor of
 * the shared badge shell), sized in em so it scales with the caller's font size and centers by
 * geometry — no font metrics or optical nudges. The glyph is hidden from assistive technology and
 * carried by the localized label instead.
 *
 * The square viewBox is centered on the glyph's bounding box, so the box center is the ink center
 * at any size.
 */
export default function AlphaBadge({ className }: { className?: string }) {
  const t = useT()
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-md border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-red-600 dark:text-red-400',
        className,
      )}
    >
      <svg viewBox="-55 -83 1100 1100" fill="currentColor" fillRule="evenodd" aria-hidden="true" className="h-[1em] w-[1em]">
        <path
          stroke="currentColor"
          strokeWidth={90}
          strokeLinejoin="round"
          strokeLinecap="round"
          d="M802 696c11,-13 31,-15 44,-4 13,11 14,31 3,44 -139,163 -210,18 -253,-118 -196,317 -465,151 -452,-134 12,-266 322,-485 467,-25 37,-78 69,-158 102,-238 6,-15 24,-23 40,-16 16,6 23,24 17,40 -42,101 -82,203 -133,300 29,94 57,277 165,151z M571 538c-127,-426 -354,-301 -366,-51 -12,259 204,352 366,51z"
        />
      </svg>
      <span className="sr-only">{t('common.alpha')}</span>
    </span>
  )
}
