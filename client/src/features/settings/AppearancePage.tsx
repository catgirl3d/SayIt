// Appearance settings page - app theme, overlay style and preview

import { useEffect, useRef, useState } from 'react'
import { open as shellOpen } from '@tauri-apps/plugin-shell'
import { ExternalLink, Info } from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import { Card, CardContent } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { themeList } from '@/themes'
import { switchTheme, getActiveThemeId } from '@/stores/theme'
import { getSetting, setSetting } from '@/services/store'
import { refreshOverlaySettings, setStreamingDisplayCache } from '@/services/recorder'
import { OVERLAY_WIDTH_PRESETS, type OverlayWidthPreset } from '@/services/recorder/types'
import { type OverlayWaveTheme } from './utils'
import { type TranslationKey } from '@/i18n'
import { useT } from '@/i18n/useT'
import { ThemePicker } from './ThemePicker'

const OVERLAY_OPTIONS: Array<{
  theme: OverlayWaveTheme
  labelKey: TranslationKey
  barColors: string[]
}> = [
    { theme: 'black-white', labelKey: 'appearance.wave.blackWhite', barColors: ['#e2e8f0', '#cbd5e1', '#94a3b8'] },
    { theme: 'black-blue', labelKey: 'appearance.wave.blackBlue', barColors: ['#22d3ee', '#3b82f6', '#6366f1'] },
    { theme: 'black-rainbow', labelKey: 'appearance.wave.blackRainbow', barColors: ['#4ade80', '#facc15', '#fb923c', '#f87171'] },
  ]

// Ordered from long to short: reading from "fullest" to "most restrained" matches the
// intuition for picking a size better than the reverse.
const WIDTH_OPTIONS: Array<{ value: OverlayWidthPreset; labelKey: TranslationKey }> = [
  { value: 'long', labelKey: 'appearance.width.long' },
  { value: 'medium', labelKey: 'appearance.width.medium' },
  { value: 'short', labelKey: 'appearance.width.short' },
]

function getBarColor(index: number, total: number, theme: OverlayWaveTheme): string {
  const t = index / Math.max(1, total - 1)
  if (theme === 'black-white') return '#f1f5f9'
  if (theme === 'black-rainbow') {
    const hue = 140 - Math.round(t * 110)
    const lightness = 64 - Math.round(Math.abs(t - 0.5) * 12)
    return `hsl(${hue} 95% ${lightness}%)`
  }
  const hue = 190 + Math.round(t * 30)
  const lightness = 62 - Math.round(Math.abs(t - 0.5) * 14)
  return `hsl(${hue} 90% ${lightness}%)`
}

function getTimerColor(theme: OverlayWaveTheme): string {
  if (theme === 'black-white') return '#e5e7eb'
  if (theme === 'black-rainbow') return '#fef08a'
  return '#bae6fd'
}



function OverlayPreview({ theme, showDuration, barCount, streaming }: { theme: OverlayWaveTheme; showDuration: boolean; barCount: number; streaming: boolean }) {
  const t = useT()
  const previewText = t('appearance.streamingPreviewText')
  const barRefs = useRef<Array<HTMLDivElement | null>>([])
  const [typed, setTyped] = useState('')

  // Streaming preview: loops through the sample text one character at a time,
  // simulating the "text appears as you speak" effect
  useEffect(() => {
    if (!streaming) {
      setTyped('')
      return
    }
    let i = 0
    let timer: ReturnType<typeof setTimeout>
    const step = () => {
      if (i <= previewText.length) {
        setTyped(previewText.slice(0, i))
        i += 1
        timer = setTimeout(step, 130)
      } else {
        // Pause briefly after the text is fully typed, then restart from the beginning
        timer = setTimeout(() => { i = 0; step() }, 1600)
      }
    }
    step()
    return () => clearTimeout(timer)
  }, [streaming, previewText])

  useEffect(() => {
    const heights = new Array(barCount).fill(3)
    let running = true
    let rafId = 0
    let lastFrame = 0
    const FRAME_INTERVAL = 1000 / 30 // 30fps is smooth enough and does not saturate the main thread

    const animate = (now: number) => {
      if (!running) return
      if (now - lastFrame >= FRAME_INTERVAL) {
        lastFrame = now
        for (let i = 0; i < heights.length; i++) {
          const target = 3 + Math.random() * 15
          heights[i] = heights[i] + (target - heights[i]) * 0.15
          const el = barRefs.current[i]
          if (el) {
            const h = Math.min(18, Math.max(3, heights[i]))
            el.style.height = `${h}px`
            el.style.opacity = String(0.7 + (h / 18) * 0.3)
          }
        }
      }
      rafId = requestAnimationFrame(animate)
    }
    rafId = requestAnimationFrame(animate)
    return () => {
      running = false
      cancelAnimationFrame(rafId)
    }
  }, [barCount])

  return (
    <div className="flex flex-col items-center gap-3">
      {/* Live streaming caption bubble (shown when enabled, with the typing animation) */}
      {streaming && (
        <div className="relative w-[260px] rounded-2xl border border-slate-600 bg-black px-3.5 py-2.5 shadow-[0_6px_16px_rgba(0,0,0,0.35)]">
          <span className="mb-1 block text-[10px] font-medium tracking-[0.18em] text-slate-400">{t('appearance.streamingPreviewLabel')}</span>
          {/* Content-driven height, bottom-aligned, matching the real overlay */}
          <div className="flex max-h-[40px] flex-col justify-end overflow-hidden text-left text-[13px] leading-5 text-slate-100">
            <div>
              {typed}
              <span
                className="ml-0.5 inline-block h-[1.05em] w-[2px] rounded-full align-middle"
                style={{ backgroundColor: '#f1f5f9', animation: 'caret-blink 1.1s ease-in-out infinite' }}
              />
            </div>
          </div>
          {/* Downward-pointing tail aimed at the recording capsule below */}
          <span
            className="absolute left-1/2 -translate-x-1/2"
            style={{ bottom: '-7px', width: 0, height: 0, borderLeft: '7px solid transparent', borderRight: '7px solid transparent', borderTop: '7px solid #000' }}
          />
        </div>
      )}
      {/* 1:1 reproduction of the real overlay styling */}
      <div className="flex items-center rounded-full border border-slate-600 bg-black px-4 py-2 shadow-[0_6px_16px_rgba(0,0,0,0.35)]">
        <div className="flex items-center gap-[2px]" style={{ height: '20px' }}>
          {Array.from({ length: barCount }, (_, index) => {
            const color = getBarColor(index, barCount, theme)
            return (
              <div
                key={index}
                ref={(el) => { barRefs.current[index] = el }}
                className="w-[2.5px] rounded-full"
                style={{
                  backgroundColor: color,
                  height: '3px',
                  opacity: 0.7,
                  transition: 'height 50ms ease-out, opacity 50ms ease-out',
                }}
              />
            )
          })}
        </div>
        {showDuration && (
          <span
            className="ml-1.5 min-w-[24px] text-right font-mono tabular-nums text-xs"
            style={{ color: getTimerColor(theme) }}
          >
            3.2s
          </span>
        )}
      </div>
      <span className="text-xs text-muted-foreground">{t('appearance.overlayPreview')}</span>
    </div>
  )
}

export default function AppearancePage() {
  const t = useT()
  const [activeTheme, setActiveTheme] = useState(getActiveThemeId)
  const [overlayWaveTheme, setOverlayWaveTheme] = useState<OverlayWaveTheme>('black-rainbow')
  const [overlayShowDuration, setOverlayShowDuration] = useState(true)
  const [overlayWidth, setOverlayWidth] = useState<OverlayWidthPreset>('medium')
  const [streamingDisplay, setStreamingDisplay] = useState(false)
  // Until the saved values have been read, the controls are hidden and carry no transition:
  // this avoids a flash of "default value -> saved value".
  // Note that the transitions must be turned off as well - visibility:hidden only makes the
  // controls invisible, the CSS transitions still run. While hidden, the selected item is still
  // the default one, so at the moment of the reveal the colours would transition from the old
  // value to the new one, which looks like "the default item's highlight fades out while the
  // saved item's fades in" (the overlay length flashing from "medium" to "short" was exactly this).
  // Always hide with an inline style, not with Tailwind's invisible class: classes only exist
  // if the source scan generated them, so as soon as a stale CSS build is running this whole
  // protection stops working (this once cost a long round of repeated debugging).
  const [ready, setReady] = useState(false)
  // animate and ready must be kept separate:
  // Per the CSS transitions spec, the browser checks whether the style *after* the change has
  // a transition. If the transition is added in the same frame as the reveal and the value
  // assignment, the browser concludes "there is a transition and the colour changed" and really
  // animates the "default item's highlight fades out, saved item's fades in" - that is the flash
  // that kept coming back.
  // Therefore the reveal frame still carries no transition, and the transition is only allowed
  // from the next frame on (by which point the colours no longer change).
  const [animate, setAnimate] = useState(false)

  useEffect(() => {
    // Fetch all values first, then apply them and set ready in a single synchronous block:
    // React batches those updates into one render, so there is no intermediate state of
    // "shown, but the values have not arrived yet" (which is exactly what caused the flash).
    //
    // Two pitfalls are avoided here:
    //  1. Every item carries its own catch fallback - Promise.all is fail-fast: as soon as one
    //     item rejects it moves on while the others have not come back yet, so ready would be
    //     set before the values are in place (and an unhandled rejection would be left behind).
    //  2. requestAnimationFrame is not used for this - it would put setReady into a different
    //     batch from the assignments, which could likewise commit one frame of "shown, but the
    //     values are still the defaults" first.
    let cancelled = false
    void (async () => {
      const [showDuration, streaming, waveTheme, width] = await Promise.all([
        getSetting('overlayShowDuration', true).catch(() => true),
        getSetting('streamingDisplayEnabled', false).catch(() => false),
        getSetting('overlayWaveTheme', 'black-rainbow').catch(() => 'black-rainbow'),
        getSetting('overlayWidth', 'medium').catch(() => 'medium'),
      ])
      if (cancelled) return
      setOverlayShowDuration(Boolean(showDuration))
      setStreamingDisplay(Boolean(streaming))
      const t = waveTheme as OverlayWaveTheme
      if (t === 'black-white' || t === 'black-blue' || t === 'black-rainbow') setOverlayWaveTheme(t)
      const w = width as OverlayWidthPreset
      if (w === 'short' || w === 'medium' || w === 'long') setOverlayWidth(w)
      setReady(true)
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!cancelled) setAnimate(true)
      }))
    })()
    return () => { cancelled = true }
  }, [])

  const handleThemeChange = async (themeId: string) => {
    await switchTheme(themeId)
    setActiveTheme(themeId)
  }

  const handleOverlayThemeChange = async (theme: OverlayWaveTheme) => {
    setOverlayWaveTheme(theme)
    await setSetting('overlayWaveTheme', theme)
    await refreshOverlaySettings()
  }

  const handleToggleDuration = async () => {
    const next = !overlayShowDuration
    setOverlayShowDuration(next)
    await setSetting('overlayShowDuration', next)
    await refreshOverlaySettings()
  }

  const handleOverlayWidthChange = async (preset: OverlayWidthPreset) => {
    setOverlayWidth(preset)
    await setSetting('overlayWidth', preset)
    await refreshOverlaySettings()
  }

  const handleToggleStreamingDisplay = () => {
    const next = !streamingDisplay
    setStreamingDisplay(next)
    setStreamingDisplayCache(next) // Sync the recorder cache immediately so it takes effect without a restart
    void setSetting('streamingDisplayEnabled', next)
  }

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-6 text-2xl font-bold">{t('appearance.title')}</h1>

      <div className="space-y-6">
        <Card>
          <CardContent className="p-6">
            <h2 id="app-theme-heading" className="mb-4 text-lg font-semibold">{t('appearance.appTheme')}</h2>
            <ThemePicker
              themes={themeList}
              value={activeTheme}
              onChange={(themeId) => void handleThemeChange(themeId)}
              labelledBy="app-theme-heading"
            />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <h2 className="mb-4 text-lg font-semibold">{t('appearance.overlayStyle')}</h2>

            {/* Wait for the values as one block, then show it. Besides the selectors, the length of
                the **overlay preview** capsule also follows overlayWidth (it has a visible
                border); if only the selectors were covered, the preview would still be seen
                shrinking from the "medium" length to "short" - that is the flash that kept
                coming back. */}
            <div className="space-y-4" style={ready ? undefined : { visibility: 'hidden' }}>
              <div>
                <p className="mb-2 text-sm text-muted-foreground">{t('appearance.waveTheme')}</p>
                <div className="grid gap-2 sm:grid-cols-3" style={ready ? undefined : { visibility: 'hidden' }}>
                  {OVERLAY_OPTIONS.map((option) => (
                    <button
                      key={option.theme}
                      type="button"
                      onClick={() => void handleOverlayThemeChange(option.theme)}
                      className={`flex items-center justify-between rounded-md border px-3 py-2 text-sm ${animate ? 'transition-colors' : ''} ${overlayWaveTheme === option.theme
                        ? 'border-primary bg-primary/5'
                        : 'border-border hover:bg-accent'
                        }`}
                    >
                      <span className="flex items-center gap-2">
                        <span className={`flex h-3.5 w-3.5 items-center justify-center rounded-full border ${overlayWaveTheme === option.theme ? 'border-primary' : 'border-muted-foreground/40'}`}>
                          {overlayWaveTheme === option.theme && <span className="h-2 w-2 rounded-full bg-primary" />}
                        </span>
                        <span>{t(option.labelKey)}</span>
                      </span>
                      <span className="flex gap-0.5">
                        {option.barColors.map((c, i) => (
                          <span key={i} className="h-3 w-1 rounded-sm" style={{ backgroundColor: c }} />
                        ))}
                      </span>
                    </button>
                  ))}
                </div>

                <div className="mt-4">
                  <p className="mb-2 text-sm text-muted-foreground">{t('appearance.overlayWidth')}</p>
                  <div className="grid gap-2 sm:grid-cols-3" style={ready ? undefined : { visibility: 'hidden' }}>
                    {WIDTH_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => void handleOverlayWidthChange(option.value)}
                        className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${animate ? 'transition-colors' : ''} ${overlayWidth === option.value
                          ? 'border-primary bg-primary/5'
                          : 'border-border hover:bg-accent'
                          }`}
                      >
                        <span className={`flex h-3.5 w-3.5 items-center justify-center rounded-full border ${overlayWidth === option.value ? 'border-primary' : 'border-muted-foreground/40'}`}>
                          {overlayWidth === option.value && <span className="h-2 w-2 rounded-full bg-primary" />}
                        </span>
                        <span>{t(option.labelKey)}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="mt-4 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">{t('appearance.showDuration')}</p>
                    <p className="text-xs text-muted-foreground">{t('appearance.showDurationDesc')}</p>
                  </div>
                  <Switch checked={overlayShowDuration} onChange={handleToggleDuration} noAnimation={!animate} hidden={!ready} />
                </div>

                <div className="mt-4 flex items-center justify-between">
                  <div className="pr-3">
                    <div className="flex items-center gap-1.5">
                      <p className="text-sm font-medium">{t('appearance.streaming')}</p>
                      <Tooltip
                        variant="light"
                        content={t('appearance.streamingHelp')}
                      >
                        <Info className="h-3.5 w-3.5 shrink-0 cursor-help text-muted-foreground/50 transition-colors hover:text-muted-foreground" />
                      </Tooltip>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t('appearance.streamingDesc')}
                      <span className="text-muted-foreground/70">
                        {t('appearance.streamingNote')}
                      </span>
                      <button
                        type="button"
                        onClick={() => void shellOpen('https://console.volcengine.com/speech/new/setting/activate?projectName=default')}
                        className="inline-flex items-center gap-0.5 text-primary underline underline-offset-2 decoration-primary/50 transition-colors hover:decoration-primary"
                      >
                        {t('appearance.streamingActivate')}
                        <ExternalLink className="h-3 w-3" />
                      </button>
                      <span className="text-muted-foreground/70">{t('appearance.streamingNoteEnd')}</span>
                    </p>
                  </div>
                  <Switch checked={streamingDisplay} onChange={handleToggleStreamingDisplay} noAnimation={!animate} hidden={!ready} />
                </div>

                <div className="mt-4 flex justify-center">
                  <OverlayPreview theme={overlayWaveTheme} showDuration={overlayShowDuration} barCount={OVERLAY_WIDTH_PRESETS[overlayWidth].barCount} streaming={streamingDisplay} />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
