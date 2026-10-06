import { cn } from '@/lib/utils'

interface SliderProps {
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
  /** Id of the visible label element; a range input has no accessible name of its own. */
  labelledBy?: string
  /** Human-readable value for assistive technology, e.g. "4.5 s". */
  valueText?: string
  disabled?: boolean
  className?: string
}

/** Native range input, so keyboard and screen-reader behavior come from the platform. */
export function Slider({ value, min, max, step, onChange, labelledBy, valueText, disabled, className }: SliderProps) {
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
      aria-labelledby={labelledBy}
      aria-valuetext={valueText}
      disabled={disabled}
      className={cn('h-2 w-full cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50', className)}
    />
  )
}
