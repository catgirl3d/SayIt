// Editor shown when the overlay wave theme "Custom" is selected: a single row with preset swatches and a custom
// picker, plus the solid / gradient toggle at the end of the row.
//
// Deliberately kept to one row. Two earlier designs were dropped: a mini overlay preview of each preset looked heavy,
// and a version with titles, start/end labels and a HEX input was too complicated for the common case.
// The live overlay preview that already sits below this editor shows the result, so this editor draws no preview of its own.

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { HexColorInput, HexColorPicker } from 'react-colorful'
import { Plus } from 'lucide-react'
import { Segmented } from '@/components/ui/segmented'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n/useT'
import {
  buildWavePalette,
  GRADIENT_WAVE_PRESETS,
  needsBrightening,
  SOLID_WAVE_PRESETS,
  visibleOnBlack,
  type CustomWaveColors,
  type CustomWaveMode,
} from '@/lib/overlayWaveColors'

/** Swatch background: samples the palette and builds a linear-gradient from it, so it matches what the overlay actually draws (dark colors already brightened). */
function swatchBackground(custom: CustomWaveColors): string {
  const stops = buildWavePalette(custom.mode === 'solid' ? 1 : 5, 'custom', custom)
  return stops.length === 1 ? stops[0] : `linear-gradient(to right, ${stops.join(', ')})`
}

/**
 * Hover hint: uses the app's own Tooltip rather than the native title attribute. The WebView draws the native one as a
 * system-styled box that does not match the UI. It writes out the hex value, in the same format as the HEX box inside
 * the picker.
 */
function tipText(label: string, hex: string): string {
  return `${label} ${hex.toUpperCase()}`
}

// The selected state is shown only by a thin ring, with a gap of background color between the ring and the swatch.
// The ring is a 1.5px translucent foreground color: a 2px solid foreground ring was too thick and too black, while
// this thinner ring is still recognizable in both light and dark themes.
const SELECTED_RING = 'ring-[1.5px] ring-foreground/50 ring-offset-2 ring-offset-background'
const ringClass = (active: boolean) => cn(
  'outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
  active ? SELECTED_RING : 'hover:ring-[1.5px] hover:ring-foreground/20 hover:ring-offset-2 hover:ring-offset-background',
)

const PANEL_GAP = 8
const VIEWPORT_MARGIN = 8

/**
 * Custom color popover: a saturation/brightness area, a hue slider and a HEX input.
 *
 * Why not the native <input type="color">: on Windows, WebView2 opens the Chromium color dialog, which shows RGB by
 * default; switching to HEX means clicking a small, inconspicuous arrow next to the numbers. On macOS it is a separate
 * floating system color panel. The hover hint already shows the color as HEX, so the picker must offer HEX as well:
 * when it offered only RGB, the HEX format was effectively undiscoverable. Both platforms now get this same panel.
 *
 * The panel is mounted on body with fixed positioning: the settings cards have overflow set, so a panel rendered inside
 * a card would be clipped. Dragging fires onChange continuously; the upper layer coalesces the writes to storage.
 */
function ColorPopover({ color, label, onChange, className, style, children }: {
  color: string
  label: string
  onChange: (hex: string) => void
  className?: string
  style?: CSSProperties
  children?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // By default the panel opens centered below the trigger; if there is no room below, it flips above.
  // It is clamped horizontally to the window edges.
  const place = () => {
    const trigger = triggerRef.current
    const panel = panelRef.current
    if (!trigger || !panel) return
    const tr = trigger.getBoundingClientRect()
    const pw = panel.offsetWidth
    const ph = panel.offsetHeight
    let top = tr.bottom + PANEL_GAP
    if (top + ph > window.innerHeight - VIEWPORT_MARGIN) top = Math.max(VIEWPORT_MARGIN, tr.top - ph - PANEL_GAP)
    const left = Math.min(Math.max(VIEWPORT_MARGIN, tr.left + tr.width / 2 - pw / 2), window.innerWidth - pw - VIEWPORT_MARGIN)
    setPos({ top, left })
  }

  useLayoutEffect(() => {
    if (open) place()
    else setPos(null)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
    }
    // The settings page scrolls inside <main>, not the window, so listen in the capture phase to catch scrolling
    // at any ancestor level and reposition the panel.
    const onMove = () => place()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
  }, [open])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={className}
        style={style}
      >
        {children}
      </button>
      {open && createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-label={label}
          className="sayit-colorful fixed z-[9999] w-56 rounded-lg border border-border bg-card p-3 text-card-foreground shadow-lg"
          style={{ top: pos ? pos.top : -9999, left: pos ? pos.left : -9999 }}
        >
          <p className="mb-2.5 text-xs font-medium">{label}</p>
          <HexColorPicker color={color} onChange={(hex) => onChange(hex.toLowerCase())} />
          <div className="mt-3 flex items-center gap-2">
            <span aria-hidden className="h-7 w-7 shrink-0 rounded-md border border-border" style={{ background: color }} />
            <HexColorInput
              prefixed
              color={color}
              onChange={(hex) => onChange(hex.toLowerCase())}
              aria-label={`${label} HEX`}
              spellCheck={false}
              className="h-7 min-w-0 flex-1 rounded-md border border-input-border bg-input-bg px-2 font-mono text-xs uppercase text-foreground transition-colors focus:border-input-focus-border focus:outline-none"
            />
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

/** Preset swatch: a single button; one click applies this color set. */
function PresetSwatch({ name, active, wide, background, onPick }: {
  name: string
  active: boolean
  /** Gradient pills are wider than the solid dots */
  wide?: boolean
  background: string
  onPick: () => void
}) {
  return (
    <Tooltip content={name}>
      <button
        type="button"
        aria-label={name}
        aria-pressed={active}
        onClick={onPick}
        className={cn('h-5 rounded-full', wide ? 'w-10' : 'w-5', ringClass(active))}
        style={{ background }}
      />
    </Tooltip>
  )
}

/**
 * Solid custom color: one swatch that opens the color popover.
 * Drawn as a dashed circle with a plus sign while no custom color has been picked yet (the current value is a preset),
 * so it does not blend in with the preset swatches.
 */
function PickDot({ color, label, active, empty, onChange }: {
  color: string
  label: string
  active: boolean
  empty?: boolean
  onChange: (hex: string) => void
}) {
  return (
    <Tooltip content={empty ? label : tipText(label, color)}>
      <ColorPopover
        color={color}
        label={label}
        onChange={onChange}
        className={cn(
          'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full', ringClass(active),
          'aria-expanded:ring-[1.5px] aria-expanded:ring-foreground/50 aria-expanded:ring-offset-2 aria-expanded:ring-offset-background',
          empty && 'border border-dashed border-muted-foreground/50 text-muted-foreground',
        )}
        style={empty ? undefined : { background: color }}
      >
        {empty && <Plus className="h-3 w-3" aria-hidden />}
      </ColorPopover>
    </Tooltip>
  )
}

/**
 * Custom gradient: two color dots (left = start, right = end) joined by a thin 2px line that shows the gradient itself.
 *
 * Earlier layouts were dropped: a "dot - bar - dot" layout had an unnecessary bar, and a single pill made the start and
 * end impossible to tell apart. The connecting line started at 6px, which was too thick, so it is 2px. An earlier design
 * also had a selection frame around the whole control, but clicks inside the frame did nothing, so the control looked
 * read-only. Therefore there is no outer frame: the whole control is split into left and right halves, each one a
 * button, and clicking on the line also opens the picker. Whichever half the pointer is over, that end's dot grows a little.
 *
 * When the custom colors are selected, both dots get the same thin ring as the preset swatches, and the end being edited
 * grows and gets the same ring. When a preset gradient is active, the two colors are still drawn, and a click starts
 * editing from that preset.
 */
function GradientPick({ value, active, labels, onChange }: {
  value: CustomWaveColors
  active: boolean
  labels: { from: string; to: string }
  onChange: (next: CustomWaveColors) => void
}) {
  const half = (side: 'from' | 'to') => (
    <Tooltip className="h-full flex-1" content={tipText(labels[side], value[side])}>
      <ColorPopover
        color={value[side]}
        label={labels[side]}
        onChange={(hex) => onChange({ ...value, [side]: hex })}
        className={cn('group/stop flex h-full w-full items-center rounded-full outline-none', side === 'from' ? 'justify-start' : 'justify-end')}
      >
        <span
          aria-hidden
          className={cn(
            'h-4 w-4 rounded-full shadow-sm transition-transform duration-150 ease-out group-hover/stop:scale-[1.15]',
            active && SELECTED_RING,
            'group-focus-visible/stop:ring-2 group-focus-visible/stop:ring-ring group-focus-visible/stop:ring-offset-2 group-focus-visible/stop:ring-offset-background',
            'group-aria-expanded/stop:scale-[1.15] group-aria-expanded/stop:ring-[1.5px] group-aria-expanded/stop:ring-foreground/50 group-aria-expanded/stop:ring-offset-2 group-aria-expanded/stop:ring-offset-background',
          )}
          style={{ background: visibleOnBlack(value[side]) }}
        />
      </ColorPopover>
    </Tooltip>
  )
  return (
    <span className="relative inline-flex h-6 w-[4.5rem] shrink-0 items-center">
      {/* 2px: any thicker and the line becomes a loud color bar (6px was too heavy); the thin line only connects the two ends */}
      <span aria-hidden className="pointer-events-none absolute inset-x-2 top-1/2 h-0.5 -translate-y-1/2 rounded-full" style={{ background: swatchBackground(value) }} />
      {half('from')}
      {half('to')}
    </span>
  )
}

export function CustomWaveEditor({ value, onChange, animate }: {
  value: CustomWaveColors
  onChange: (next: CustomWaveColors) => void
  animate: boolean
}) {
  const t = useT()
  const presetsId = useId()
  const gradient = value.mode === 'gradient'
  const brightened = needsBrightening(value.from) || (gradient && needsBrightening(value.to))

  const solidIsPreset = SOLID_WAVE_PRESETS.includes(value.from)
  const gradientIsPreset = GRADIENT_WAVE_PRESETS.some(([from, to]) => from === value.from && to === value.to)

  return (
    <div className="mt-3 space-y-2">
      {/* Swatches start from the left, aligned with the theme cards above. Solid / gradient is a secondary switch, shrunk to xs and placed at the end of the row: placed first, it looked too large and awkward */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <span id={presetsId} className="sr-only">{t('appearance.wave.presets')}</span>
        <div role="group" aria-labelledby={presetsId} className="flex flex-wrap items-center gap-2.5">
          {gradient
            ? GRADIENT_WAVE_PRESETS.map(([from, to]) => {
              const preset: CustomWaveColors = { mode: 'gradient', from, to }
              return (
                <PresetSwatch
                  key={`${from}-${to}`}
                  name={`${from.toUpperCase()} → ${to.toUpperCase()}`}
                  active={from === value.from && to === value.to}
                  wide
                  background={swatchBackground(preset)}
                  onPick={() => onChange(preset)}
                />
              )
            })
            : SOLID_WAVE_PRESETS.map((from) => (
              <PresetSwatch
                key={from}
                name={from.toUpperCase()}
                active={from === value.from}
                background={swatchBackground({ ...value, mode: 'solid', from })}
                onPick={() => onChange({ ...value, from })}
              />
            ))}

          {/* Custom picker: separated from the preset swatches by a thin vertical divider */}
          <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
          {gradient ? (
            <GradientPick
              value={value}
              active={!gradientIsPreset}
              labels={{ from: t('appearance.wave.from'), to: t('appearance.wave.to') }}
              onChange={onChange}
            />
          ) : (
            <PickDot color={value.from} label={t('appearance.wave.color')} active={!solidIsPreset} empty={solidIsPreset} onChange={(from) => onChange({ ...value, from })} />
          )}
        </div>

        <Segmented<CustomWaveMode>
          label={t('appearance.wave.customStyle')}
          size="xs"
          value={value.mode}
          options={[
            { value: 'solid', label: t('appearance.wave.solid') },
            { value: 'gradient', label: t('appearance.wave.gradient') },
          ]}
          onChange={(mode) => onChange({ ...value, mode })}
          animated={animate}
          className="ml-auto shrink-0 gap-0.5"
        />
      </div>

      {/* The picker holds the color the user chose; here we draw the actually brightened color so it does not look like the change was ignored */}
      {brightened && (
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span>{t('appearance.wave.brightened')}</span>
          <span
            aria-hidden
            className={cn('inline-block h-3 rounded-full', gradient ? 'w-10' : 'w-3')}
            style={{ background: swatchBackground(value) }}
          />
        </p>
      )}
    </div>
  )
}
