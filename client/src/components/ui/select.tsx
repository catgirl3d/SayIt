import { forwardRef, useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Check } from 'lucide-react'
import { useT } from '@/i18n/useT'
import { cn } from '@/lib/utils'

export interface SelectOption {
  value: string
  label: string
}

export interface SelectProps {
  value: string
  onChange: (value: string) => void
  options?: SelectOption[]
  children?: React.ReactNode
  className?: string
  placeholder?: string
  disabled?: boolean
}

const Select = forwardRef<HTMLButtonElement, SelectProps>(
  ({ value, onChange, options, children, className, placeholder, disabled = false }, ref) => {
    const t = useT()
    const [isOpen, setIsOpen] = useState(false)
    const [dropdownStyle, setDropdownStyle] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null)
    const buttonRef = useRef<HTMLButtonElement>(null)
    const dropdownRef = useRef<HTMLDivElement>(null)

    // If options were passed as children (<option>), parse them
    const parsedOptions: SelectOption[] = options || []

    if (!options && children) {
      const childArray = Array.isArray(children) ? children : [children]
      childArray.forEach((child: any) => {
        if (child?.type === 'option') {
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
        className="fixed z-[9999] rounded-md border border-border bg-card shadow-xl"
        style={{
          top: `${dropdownStyle.top}px`,
          left: `${dropdownStyle.left}px`,
          width: `${dropdownStyle.width}px`,
          maxHeight: `${dropdownStyle.maxHeight}px`,
        }}
      >
        <div
          className="custom-scrollbar overflow-y-auto py-1"
          style={{ maxHeight: `${dropdownStyle.maxHeight - 2}px` }}
        >
          {parsedOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => handleSelect(option.value)}
              className={cn(
                'flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors',
                option.value === value
                  ? 'bg-primary/5 text-primary font-medium'
                  : 'text-foreground hover:bg-accent',
              )}
            >
              <span className="truncate">{option.label}</span>
              {option.value === value && <Check className="ml-2 h-4 w-4 shrink-0" />}
            </button>
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
          className={cn(
            'flex h-9 w-full items-center justify-between rounded-md border border-input-border bg-input-bg px-3 text-sm text-foreground transition-colors',
            'hover:border-muted-foreground/40 focus:border-input-focus-border focus:outline-none focus:ring-2 focus:ring-input-focus-ring/20',
            'disabled:cursor-not-allowed disabled:opacity-50',
            isOpen && 'border-input-focus-border ring-2 ring-input-focus-ring/20',
          )}
        >
          <span className={cn('truncate', !selectedOption && 'text-input-placeholder')}>
            {selectedOption?.label || placeholder || t('ui.selectPlaceholder')}
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
