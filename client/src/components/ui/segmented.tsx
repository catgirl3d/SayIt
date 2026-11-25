// Radio pill group (recognition language / download source / compute backend / model retention …)
//
// Why it exists: this shape had been hand-copied five times across the settings pages, each time as
// a bare <button> whose selected state was **color only** (border-primary bg-primary), with no
// role="radio" and no aria-checked. Keyboard users tabbing through "Auto / Chinese / English" could
// not tell which value was current. Collecting it into one component fixes the semantics once.
//
// The look matches the old markup (md is the former px-4 py-1.5 text-sm, sm is px-3 py-1 text-xs);
// the only addition is font-medium on the selected option as a non-color marker. The selected
// background later became a sliding indicator (it slides over when the value changes).

import { useRef } from 'react'
import { cn } from '@/lib/utils'
import { useSlidingIndicator } from './useSlidingIndicator'

export interface SegmentedOption<T> {
  value: T
  label: string
  disabled?: boolean
}

interface SegmentedProps<T> {
  /** Accessible name. Pass labelledBy instead when there is a visible heading */
  label?: string
  labelledBy?: string
  value: T
  options: ReadonlyArray<SegmentedOption<T>>
  onChange: (value: T) => void
  /** xs: a secondary toggle attached to the end of a row of content (e.g. solid / gradient of the custom wave), one step smaller than sm */
  size?: 'xs' | 'sm' | 'md'
  /** Disable the whole group (e.g. while the model is reloading after a backend switch) */
  disabled?: boolean
  /** Whether color transitions and the sliding indicator movement animate. */
  animated?: boolean
  className?: string
}

export function Segmented<T extends string | number>({
  label,
  labelledBy,
  value,
  options,
  onChange,
  size = 'md',
  disabled,
  animated = true,
  className,
}: SegmentedProps<T>) {
  const groupRef = useRef<HTMLDivElement>(null)
  // The selected background is a separate sliding block (see useSlidingIndicator); the options no
  // longer paint it themselves. With animated=false (settings values just read back) the indicator
  // may only appear in place, otherwise it would be another "the setting moved on its own".
  const indicatorRef = useSlidingIndicator(groupRef, value, { animated })
  // A disabled selected chip must not keep the full-strength selected background: the text dims,
  // so the indicator dims with it (group-level and selected-option-level disabled).
  const indicatorDimmed = disabled || Boolean(options.find((option) => option.value === value)?.disabled)
  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={label}
      aria-labelledby={labelledBy}
      className={cn('relative flex flex-wrap items-center gap-1', className)}
    >
      <span
        ref={indicatorRef}
        aria-hidden
        className={cn(
          'sliding-indicator',
          indicatorDimmed ? 'bg-foreground/[0.04]' : 'bg-foreground/[0.08]',
          size === 'xs' ? 'rounded-md' : 'rounded-lg',
        )}
      />
      {options.map((option) => {
        const isActive = option.value === value
        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={isActive}
            disabled={disabled || option.disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              'relative inline-flex items-center justify-center rounded-lg font-medium outline-none disabled:pointer-events-none disabled:opacity-50',
              'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              animated && 'transition-colors',
              size === 'xs' ? 'h-6 rounded-md px-2 text-xs' : size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm',
              // The selected option's hover sits on top of the indicator: 0.08 + 0.05 ≈ the old 0.13.
              isActive
                ? 'bg-transparent text-foreground hover:bg-foreground/[0.05]'
                : 'bg-transparent text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
