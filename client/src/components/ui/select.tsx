import { forwardRef, Fragment, useState, useRef, useEffect, useLayoutEffect, useCallback, isValidElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Check } from 'lucide-react'
import { useT } from '@/i18n/useT'
import { cn } from '@/lib/utils'

export interface SelectOption {
  value: string
  label: string
  /**
   * Optional secondary part (for example a model name) rendered after the label in a
   * muted style, separated by a dimmed middle dot. It stays part of the option's text,
   * so accessible names and screen readers see "label · secondary".
   */
  secondary?: string
  /** Optional full label for hover when the visible option may be truncated. */
  title?: string
  /**
   * Optional group heading. A heading is rendered above the first option of each run of
   * consecutive options that share the same group, so options must arrive already grouped.
   */
  group?: string
}

/** Full text of an option, including the secondary part and the separator between them. */
function optionText(option: SelectOption): string {
  return option.secondary ? `${option.label} · ${option.secondary}` : option.label
}

function optionTitle(option: SelectOption): string | undefined {
  return option.title ?? (option.secondary ? optionText(option) : undefined)
}

/**
 * Label as rendered in the trigger and the list: the secondary part is muted behind a thin
 * vertical rule so the primary name stays dominant. The rule is decorative; a screen-reader
 * only " · " keeps the plain-text name "label · secondary" for tests and assistive tech.
 */
function renderOptionLabel(option: SelectOption) {
  if (!option.secondary) return option.label
  return (
    <>
      {option.label}
      {' '}
      <span aria-hidden="true" className="mx-1.5 inline-block h-3.5 w-px bg-border align-middle" />
      <span className="sr-only">·</span>
      {' '}
      <span className="text-muted-foreground">{option.secondary}</span>
    </>
  )
}

export interface SelectProps {
  value: string
  onChange: (value: string) => void
  options?: SelectOption[]
  children?: ReactNode
  className?: string
  placeholder?: string
  disabled?: boolean
  /** Associates the trigger with a visible label because a button has no htmlFor. */
  labelledBy?: string
}

interface OptionElementProps {
  value?: string
  children?: string
}

const Select = forwardRef<HTMLButtonElement, SelectProps>(
  ({ value, onChange, options, children, className, placeholder, disabled = false, labelledBy }, ref) => {
    const t = useT()
    const [isOpen, setIsOpen] = useState(false)
    const [dropdownStyle, setDropdownStyle] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null)
    const buttonRef = useRef<HTMLButtonElement | null>(null)
    const dropdownRef = useRef<HTMLDivElement>(null)

    // If options were passed as children (<option>), parse them
    const parsedOptions: SelectOption[] = options || []

    if (!options && children) {
      const childArray: ReactNode[] = Array.isArray(children) ? children : [children]
      childArray.forEach((child) => {
        if (isValidElement<OptionElementProps>(child) && child.type === 'option') {
          parsedOptions.push({
            value: child.props.value || '',
            label: child.props.children || '',
          })
        }
      })
    }

    const selectedOption = parsedOptions.find((opt) => opt.value === value)

    const updatePosition = useCallback(() => {
      const el = buttonRef.current
      if (!el) return

      const rect = el.getBoundingClientRect()
      const spaceBelow = window.innerHeight - rect.bottom - 8
      const spaceAbove = rect.top - 8
      const openUpwards = spaceBelow < 180 && spaceAbove > spaceBelow

      const maxHeight = Math.min(240, Math.max(120, openUpwards ? spaceAbove : spaceBelow))
      const top = openUpwards ? rect.top - maxHeight - 4 : rect.bottom + 4

      setDropdownStyle({
        top,
        left: rect.left,
        width: rect.width,
        maxHeight,
      })
    }, [])

    useLayoutEffect(() => {
      if (isOpen) {
        updatePosition()
        const handleScrollOrResize = () => updatePosition()
        window.addEventListener('resize', handleScrollOrResize)
        window.addEventListener('scroll', handleScrollOrResize, true)
        return () => {
          window.removeEventListener('resize', handleScrollOrResize)
          window.removeEventListener('scroll', handleScrollOrResize, true)
        }
      } else {
        setDropdownStyle(null)
      }
    }, [isOpen, updatePosition])

    useEffect(() => {
      const handleClickOutside = (event: MouseEvent) => {
        const target = event.target as Node
        if (
          buttonRef.current && !buttonRef.current.contains(target) &&
          dropdownRef.current && !dropdownRef.current.contains(target)
        ) {
          setIsOpen(false)
        }
      }

      if (isOpen) {
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
      }
    }, [isOpen])

    const handleSelect = (optionValue: string) => {
      onChange(optionValue)
      setIsOpen(false)
    }

    const dropdown = isOpen && dropdownStyle ? createPortal(
      <div
        ref={dropdownRef}
        className="fixed z-[9999] rounded-md border border-border bg-popover shadow-xl"
        style={{
          top: `${dropdownStyle.top}px`,
          left: `${dropdownStyle.left}px`,
          width: `${dropdownStyle.width}px`,
          maxHeight: `${dropdownStyle.maxHeight}px`,
        }}
      >
        <div
          className="overflow-y-auto py-1"
          style={{ maxHeight: `${dropdownStyle.maxHeight - 2}px` }}
        >
          {parsedOptions.map((option, index) => (
            <Fragment key={option.value}>
              {option.group !== undefined && option.group !== parsedOptions[index - 1]?.group && (
                <div
                  className={cn(
                    'px-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground',
                    index === 0 ? 'pt-1' : 'mt-1 border-t border-border pt-2.5',
                  )}
                >
                  {option.group}
                </div>
              )}
              <button
                type="button"
                onClick={() => handleSelect(option.value)}
                className={cn(
                  'flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors',
                  option.value === value
                    ? 'bg-primary/5 text-primary font-medium'
                    : 'text-foreground hover:bg-accent',
                )}
              >
                <span className="truncate" title={optionTitle(option)}>{renderOptionLabel(option)}</span>
                {option.value === value && <Check className="ml-2 h-4 w-4 shrink-0" />}
              </button>
            </Fragment>
          ))}
        </div>
      </div>,
      document.body,
    ) : null

    return (
      <div className={cn('relative', className)}>
        <button
          ref={(node) => {
            buttonRef.current = node
            if (typeof ref === 'function') ref(node)
            else if (ref) (ref as React.MutableRefObject<HTMLButtonElement | null>).current = node
          }}
          type="button"
          onClick={() => !disabled && setIsOpen(!isOpen)}
          disabled={disabled}
          aria-labelledby={labelledBy}
          aria-expanded={isOpen}
          className={cn(
            'flex h-9 w-full items-center justify-between rounded-md border border-input-border bg-input-bg px-3 text-sm text-foreground transition-colors',
            'hover:border-muted-foreground/40 focus:border-input-focus-border focus:outline-none focus:ring-2 focus:ring-input-focus-ring/20',
            'disabled:cursor-not-allowed disabled:opacity-50',
            isOpen && 'border-input-focus-border ring-2 ring-input-focus-ring/20',
          )}
        >
          <span
            className={cn('truncate', !selectedOption && 'text-input-placeholder')}
            title={selectedOption ? optionTitle(selectedOption) : undefined}
          >
            {selectedOption?.label
              ? renderOptionLabel(selectedOption)
              : placeholder || t('ui.selectPlaceholder')}
          </span>
          <ChevronDown
            className={cn(
              'ml-2 h-4 w-4 shrink-0 text-muted-foreground transition-transform',
              isOpen && 'rotate-180',
            )}
          />
        </button>

        {dropdown}
      </div>
    )
  },
)

Select.displayName = 'Select'

export { Select }
