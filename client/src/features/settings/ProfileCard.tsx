// Presentational shell for one provider profile card, shared by the AI Services and
// Speech Recognition settings sections. The two sections render the same anatomy —
// a full-card radio button, a title row with the status chip, a subtitle row with
// hover-revealed test/edit/delete actions, and an optional extra row for domain copy
// (e.g. the ASR provider blurb) — with domain-computed strings, chip nodes and
// disabled flags passed in from the caller.
//
// The action container owns the pointer-events gate: while the actions are hidden they
// are not mouse targets, but they stay keyboard-reachable, and focus or hover reveals
// them (an invisible-but-clickable control would swallow clicks on the card).

import type { ReactNode } from 'react'
import { CheckCircle2, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n/useT'
import { cardIconButtonClass } from './formStyles'

export interface ProfileCardAction {
  ariaLabel: string
  onClick: () => void
  disabled?: boolean
  /** Shows the refresh icon spinning — set while this action is in flight. */
  spinning?: boolean
}

interface ProfileCardProps {
  active: boolean
  onActivate: () => void
  /** Disables the full-card radio, e.g. while another activation is pending. */
  activateDisabled?: boolean
  /** Full accessible name for the card radio, already localized by the caller. */
  ariaLabel: string
  title: string
  subtitle: string
  /** Tooltip of the subtitle, when it differs from the visible text. */
  subtitleTitle?: string
  /** Pre-built status chip (each section owns its tone vocabulary). */
  statusChip: ReactNode
  /**
   * Keeps the action buttons always visible instead of hover-only. Used for
   * cards that need setup: the actions are the only way to fix them, so hiding
   * them behind hover would strand the user on a dead card.
   */
  actionsVisible?: boolean
  test: ProfileCardAction
  edit: ProfileCardAction
  delete: ProfileCardAction
  children?: ReactNode
  /** Extra classes on the card shell, e.g. a temporary dimmed state. */
  className?: string
}

export function ProfileCard({
  active,
  onActivate,
  activateDisabled,
  ariaLabel,
  title,
  subtitle,
  subtitleTitle,
  statusChip,
  actionsVisible,
  test,
  edit,
  delete: deleteAction,
  children,
  className,
}: ProfileCardProps) {
  const t = useT()
  return (
    <div
      className={cn(
        'group relative rounded-lg border p-2.5 transition-colors',
        active ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/50',
        className,
      )}
    >
      {/* Full-card radio button. Cannot be a plain <button> wrapper: the card
          contains its own icon buttons, and nested buttons break both screen
          readers and keyboard navigation. */}
      <button
        type="button"
        role="radio"
        aria-checked={active}
        aria-label={ariaLabel}
        disabled={activateDisabled}
        onClick={onActivate}
        className="absolute inset-0 rounded-lg"
      />

      <div className="flex items-center gap-1.5">
        {active && (
          <Tooltip className="pointer-events-auto relative z-10 shrink-0" content={t('common.inUse')}>
            <CheckCircle2 className="h-4 w-4 shrink-0 cursor-help text-success-strong" aria-label={t('common.inUse')} />
          </Tooltip>
        )}
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={title}>{title}</span>
        {statusChip}
      </div>

      <div className="mt-1 flex items-center gap-1.5">
        <span
          className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
          title={subtitleTitle ?? subtitle}
        >
          {subtitle}
        </span>
        <div
          className={cn(
            'relative z-10 flex shrink-0 items-center gap-0.5 transition-opacity',
            actionsVisible
              ? 'pointer-events-auto opacity-100'
              : 'pointer-events-none opacity-0 focus-within:pointer-events-auto focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100',
          )}
        >
          <Tooltip content={t('common.test')}>
            <button
              type="button"
              onClick={test.onClick}
              disabled={test.disabled}
              aria-label={test.ariaLabel}
              className={cardIconButtonClass}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', test.spinning && 'animate-spin')} aria-hidden />
            </button>
          </Tooltip>
          <Tooltip content={t('common.edit')}>
            <button
              type="button"
              onClick={edit.onClick}
              disabled={edit.disabled}
              aria-label={edit.ariaLabel}
              className={cardIconButtonClass}
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden />
            </button>
          </Tooltip>
          <Tooltip content={t('common.delete')}>
            <button
              type="button"
              onClick={deleteAction.onClick}
              disabled={deleteAction.disabled}
              aria-label={deleteAction.ariaLabel}
              className={cardIconButtonClass}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden />
            </button>
          </Tooltip>
        </div>
      </div>

      {children}
    </div>
  )
}
