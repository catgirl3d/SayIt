import { useState } from 'react'
import { Check } from 'lucide-react'
import { Segmented } from '@/components/ui/segmented'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n/useT'
import type { ThemeDefinition } from '@/themes'

type Brightness = 'light' | 'dark'

interface ThemePickerProps {
  themes: ReadonlyArray<ThemeDefinition>
  value: string
  onChange: (id: string) => void
  /** Id of the visible heading that names the tile group. */
  labelledBy?: string
  /** Accessible name for the tile group when there is no visible heading. */
  label?: string
}

/** A miniature app window drawn from the theme's own preview colours. */
function ThemeThumbnail({ colors }: { colors: ThemeDefinition['previewColors'] }) {
  return (
    <span
      aria-hidden="true"
      // The border comes from the current theme so a white thumbnail (the light
      // theme has bg and sidebar both #ffffff) still stands out on a light card.
      className="flex h-14 overflow-hidden rounded-md border border-border"
      style={{ backgroundColor: colors.bg }}
    >
      <span className="flex w-1/4 shrink-0 flex-col gap-1 p-1.5" style={{ backgroundColor: colors.sidebar }}>
        <span className="block h-1 rounded-full" style={{ backgroundColor: colors.primary }} />
        <span className="block h-1 w-2/3 rounded-full" style={{ backgroundColor: colors.accent }} />
        <span className="block h-1 w-2/3 rounded-full" style={{ backgroundColor: colors.accent }} />
      </span>
      <span className="flex flex-1 p-2">
        <span
          className="flex w-full flex-col justify-between rounded-sm p-1.5"
          style={{ backgroundColor: colors.accent }}
        >
          <span className="block h-1 w-1/2 rounded-full" style={{ backgroundColor: colors.bg }} />
          <span className="block h-2 w-7 rounded-sm" style={{ backgroundColor: colors.primary }} />
        </span>
      </span>
    </span>
  )
}

/**
 * Theme chooser split into a light and a dark group, so only the themes of one
 * brightness are on screen at a time instead of one long list.
 *
 * Switching the group only changes what is listed; it never changes the applied
 * theme. Until the user browses to the other group, the listed group follows the
 * active theme.
 */
export function ThemePicker({ themes, value, onChange, labelledBy, label }: ThemePickerProps) {
  const t = useT()
  // null means "follow the active theme"; it is set only while browsing the other group.
  const [browsed, setBrowsed] = useState<Brightness | null>(null)

  const activeBrightness: Brightness = themes.find((theme) => theme.id === value)?.isDark ? 'dark' : 'light'
  const brightness = browsed ?? activeBrightness
  const visible = themes.filter((theme) => theme.isDark === (brightness === 'dark'))

  return (
    <div className="space-y-3">
      <Segmented<Brightness>
        label={t('appearance.themeBrightness')}
        size="sm"
        value={brightness}
        options={[
          { value: 'light', label: t('appearance.themeLight') },
          { value: 'dark', label: t('appearance.themeDark') },
        ]}
        onChange={setBrowsed}
      />

      <div
        role="radiogroup"
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : label}
        className="grid grid-cols-2 gap-3 sm:grid-cols-3"
      >
        {visible.map((theme) => {
          const isActive = theme.id === value
          return (
            <button
              key={theme.id}
              type="button"
              role="radio"
              aria-checked={isActive}
              onClick={() => {
                setBrowsed(null)
                onChange(theme.id)
              }}
              className={cn(
                'flex flex-col gap-2 rounded-lg border p-2 text-left outline-none transition-colors',
                'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                isActive ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent',
              )}
            >
              <ThemeThumbnail colors={theme.previewColors} />
              <span className="flex items-center justify-between gap-2 px-0.5">
                <span className="truncate text-sm font-medium">{theme.name}</span>
                {/* A check mark so the selected state is not carried by colour alone. */}
                {isActive && <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
