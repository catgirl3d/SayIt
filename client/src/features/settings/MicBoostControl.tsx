import type { ChangeEvent, KeyboardEvent } from 'react'
import { getLocale, type TranslationKey } from '@/i18n'
import { useT } from '@/i18n/useT'
import { cn } from '@/lib/utils'
import { MIC_BOOST_MIN } from '@/services/defaults'
import {
  MIC_BOOST_HIGH_ABOVE,
  MIC_BOOST_POSITION_MAX,
  MIC_BOOST_PRESETS,
  MIC_BOOST_RISK_ABOVE,
  micBoostDecibels,
  micBoostForKey,
  micBoostToPosition,
  micBoostZone,
  positionToMicBoost,
  type MicBoostZone,
} from './micBoostScale'

const HIGH_EDGE = micBoostToPosition(MIC_BOOST_HIGH_ABOVE) * 100
const RISK_EDGE = micBoostToPosition(MIC_BOOST_RISK_ABOVE) * 100

/** Tailwind needs the full class names in the source, so the per-zone colors live in one literal table. */
const ZONE_STYLES: Record<MicBoostZone, { thumb: string; label: string }> = {
  safe: { thumb: 'border-info', label: 'text-info-strong' },
  high: { thumb: 'border-warning', label: 'text-warning-strong' },
  risk: { thumb: 'border-destructive', label: 'text-destructive-strong' },
}

const ZONE_LABEL_KEYS: Record<MicBoostZone, TranslationKey> = {
  safe: 'mic.boostZoneSafe',
  high: 'mic.boostZoneHigh',
  risk: 'mic.boostZoneRisk',
}

/** The same zone colors twice: faint for the whole rail, solid for the part up to the thumb. */
function zoneGradient(alpha: string): string {
  return `linear-gradient(90deg, hsl(var(--info)${alpha}) 0 ${HIGH_EDGE}%, `
    + `hsl(var(--warning)${alpha}) ${HIGH_EDGE}% ${RISK_EDGE}%, `
    + `hsl(var(--destructive)${alpha}) ${RISK_EDGE}% 100%)`
}

const RAIL_FAINT = zoneGradient(' / 0.26')
const RAIL_SOLID = zoneGradient('')

function formatGain(gain: number): string {
  return gain.toLocaleString(getLocale(), { maximumFractionDigits: 1 })
}

export default function MicBoostControl({
  gain,
  onChange,
  labelledBy,
  animated,
}: {
  gain: number
  onChange: (gain: number) => void
  /** Id of the visible label element; a range input has no accessible name of its own. */
  labelledBy: string
  /** Whether color changes should animate; off until the page has loaded its saved values. */
  animated: boolean
}) {
  const t = useT()
  const position = micBoostToPosition(gain)
  const percent = position * 100
  const zone = micBoostZone(gain)
  const decibels = micBoostDecibels(gain)
  const valueLabel = t('mic.boostValue', { value: formatGain(gain) })
  const decibelLabel = t('mic.boostDecibels', { value: decibels > 0 ? `+${decibels}` : String(decibels) })
  const zoneLabel = t(ZONE_LABEL_KEYS[zone])

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const next = positionToMicBoost(Number(event.target.value) / MIC_BOOST_POSITION_MAX)
    if (next !== gain) onChange(next)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const next = micBoostForKey(event.key, gain)
    if (next === null) return
    event.preventDefault()
    if (next !== gain) onChange(next)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold leading-none tabular-nums">{valueLabel}</span>
          <span className="text-xs tabular-nums text-muted-foreground">{decibelLabel}</span>
        </div>

        <div className="flex flex-wrap justify-end gap-1.5" role="group" aria-labelledby={labelledBy}>
          {MIC_BOOST_PRESETS.map((preset) => {
            const active = preset === gain
            return (
              <button
                key={preset}
                type="button"
                aria-pressed={active}
                title={preset === MIC_BOOST_MIN ? t('mic.boostOffTitle') : undefined}
                onClick={() => { if (!active) onChange(preset) }}
                className={cn(
                  'h-7 min-w-10 rounded-full border px-2.5 text-xs tabular-nums outline-none',
                  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card',
                  animated && 'transition-colors',
                  active
                    ? 'border-info/50 bg-info/15 font-medium text-info-strong'
                    : 'border-border text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground',
                )}
              >
                {t('mic.boostValue', { value: formatGain(preset) })}
              </button>
            )
          })}
        </div>
      </div>

      <div className="space-y-1.5">
        {/*
          The visible track is drawn separately from a transparent native range input laid over it, so
          pointer, keyboard and screen-reader behavior come from the platform. The input's thumb is
          18px wide and the visible rail is inset by half of that, which makes the native thumb travel
          exactly the visible rail.
        */}
        <div className="relative h-7">
          <input
            type="range"
            min={0}
            max={MIC_BOOST_POSITION_MAX}
            step={1}
            value={Math.round(position * MIC_BOOST_POSITION_MAX)}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            aria-labelledby={labelledBy}
            aria-valuetext={`${valueLabel}, ${decibelLabel}, ${zoneLabel}`}
            className="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer appearance-none opacity-0 [&::-webkit-slider-thumb]:h-7 [&::-webkit-slider-thumb]:w-[18px] [&::-webkit-slider-thumb]:appearance-none"
          />
          <div className="pointer-events-none absolute inset-x-[9px] inset-y-0" aria-hidden>
            <div className="absolute inset-x-0 top-[10px] h-2 rounded-full" style={{ background: RAIL_FAINT }} />
            <div
              className="absolute inset-x-0 top-[10px] h-2"
              style={{ background: RAIL_SOLID, clipPath: `inset(0 ${100 - percent}% 0 0 round 4px)` }}
            />
            <div className="absolute top-[10px] h-2 w-0.5 -translate-x-1/2 bg-card" style={{ left: `${HIGH_EDGE}%` }} />
            <div className="absolute top-[10px] h-2 w-0.5 -translate-x-1/2 bg-card" style={{ left: `${RISK_EDGE}%` }} />
          </div>
          <div
            aria-hidden
            className={cn(
              'pointer-events-none absolute top-1 h-5 w-5 -translate-x-1/2 rounded-full border-4 bg-white shadow-md',
              ZONE_STYLES[zone].thumb,
              animated && 'transition-shadow',
              'peer-hover:ring-4 peer-hover:ring-foreground/10',
              'peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-card',
            )}
            style={{ left: `calc(9px + (100% - 18px) * ${position})` }}
          />
        </div>

        <div className={cn('mx-[9px] flex items-center gap-1.5 text-xs font-medium', ZONE_STYLES[zone].label)} aria-hidden>
          <span className="h-2 w-2 rounded-full bg-current" />
          {zoneLabel}
        </div>
      </div>
    </div>
  )
}
