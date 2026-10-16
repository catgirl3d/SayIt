// Text formatting switches — client-side text processing that does not need AI

import { useEffect, useRef, useState } from 'react'
import { HelpCircle } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Tooltip } from '@/components/ui/tooltip'
import {
  getTextPostProcessOptions,
  saveTextPostProcessOptions,
  DEFAULT_POST_PROCESS,
  type TextPostProcessOptions,
} from '@/services/textPostProcess'
import type { TranslationKey } from '@/i18n'
import { useT } from '@/i18n/useT'
import { useAiEnabled } from '@/hooks/useAiEnabled'
import { getSpeechInputLanguage } from '@/services/speechInputLanguage'

interface ToggleDef {
  key: keyof TextPostProcessOptions
  titleKey: TranslationKey
  /** Short description shown inline next to the switch */
  hintKey: TranslationKey
  /** Detailed description + examples shown on the help hover (newlines use \n) */
  detailKey: TranslationKey
  /** Only meaningful for Chinese speech; hidden for every other speech language. */
  chineseOnly?: boolean
}

/**
 * Keys are stored, not copy.
 *
 * The detail text is assembled from description + examples + the AI note, so the
 * concatenation happens at render time; doing it at module load would freeze the
 * language that was active back then.
 */
const TOGGLES: ToggleDef[] = [
  {
    key: 'autoSegment',
    titleKey: 'textFormat.autoSegment.title',
    hintKey: 'textFormat.autoSegment.hint',
    detailKey: 'textFormat.autoSegment.help',
    chineseOnly: true,
  },
  {
    key: 'normalizeNumbers',
    titleKey: 'textFormat.normalizeNumbers.title',
    hintKey: 'textFormat.normalizeNumbers.hint',
    detailKey: 'textFormat.normalizeNumbers.help',
    chineseOnly: true,
  },
  {
    key: 'stripTrailingPunctuation',
    titleKey: 'textFormat.stripTrailing.title',
    hintKey: 'textFormat.stripTrailing.hint',
    detailKey: 'textFormat.stripTrailing.help',
  },
  {
    key: 'punctuationToSpace',
    titleKey: 'textFormat.punctuationToSpace.title',
    hintKey: 'textFormat.punctuationToSpace.hint',
    detailKey: 'textFormat.punctuationToSpace.help',
  },
]

export default function TextFormatSection() {
  const t = useT()
  const aiEnabled = useAiEnabled()
  const [opts, setOpts] = useState<TextPostProcessOptions>(DEFAULT_POST_PROCESS)
  const initialized = useRef(false)
  // Before the saved values are read the switches stay hidden and animate nothing: this
  // avoids drawing the defaults and then jumping to the saved values (a visible flash).
  const [ready, setReady] = useState(false)
  // animate is separate from ready: ready decides when to show, animate when transitions
  // are allowed. If the transition is re-enabled in the same frame the value is applied,
  // the CSS spec makes the browser animate "default -> saved value" for real (that is the
  // flash). So the reveal frame still has no transition; it is added two frames later,
  // after the value has settled.
  const [animate, setAnimate] = useState(false)
  // Paragraph splitting and number normalization only do anything for Chinese speech.
  const [showChineseOnlyToggles, setShowChineseOnlyToggles] = useState(false)

  useEffect(() => {
    const optionsLoaded = getTextPostProcessOptions()
      .then((loaded) => {
        setOpts(loaded)
        initialized.current = true
      })
    const speechLanguageLoaded = getSpeechInputLanguage()
      .then((language) => setShowChineseOnlyToggles(language === 'zh'))
    // Reveal the switches only after both reads settle; a failed read still reveals them
    // with the default values, so they can never stay hidden.
    Promise.allSettled([optionsLoaded, speechLanguageLoaded]).then(() => {
      setReady(true)
      requestAnimationFrame(() => requestAnimationFrame(() => setAnimate(true)))
    })
  }, [])

  useEffect(() => {
    if (!initialized.current) return
    void saveTextPostProcessOptions(opts)
  }, [opts])

  const toggle = (key: keyof TextPostProcessOptions) => {
    setOpts((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  const visibleToggles = TOGGLES.filter((def) => !def.chineseOnly || showChineseOnlyToggles)

  return (
    <div className="mb-6 rounded-lg border border-border">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-lg font-semibold">{t('textFormat.title')}</h2>
        {/* State the effect condition: these are the fallback formatting rules we apply
            when there is no AI. With AI cleanup on, formatting belongs to the AI and this
            section does not apply at all — both sides doing it would fight each other.
            Text replacements are not affected; see the Text replacement section on the
            Hotwords page. */}
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t('textFormat.desc')}
        </p>
      </div>
      <div className="divide-y divide-border/60">
        {/* The loop variable is def, not t: t is the translation function now and would be shadowed */}
        {visibleToggles.map((def) => {
          const labelId = `text-format-${def.key}-label`
          return (
            <div key={def.key} className="flex items-center gap-2.5 px-4 py-2.5">
              <Switch
                checked={opts[def.key]}
                onChange={() => toggle(def.key)}
                labelledBy={labelId}
                disabled={aiEnabled}
                size="sm"
                noAnimation={!animate}
                hidden={!ready}
                className="shrink-0"
              />
              <span id={labelId} className="shrink-0 text-sm font-medium">{t(def.titleKey)}</span>
              <div className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="min-w-0 truncate text-xs text-muted-foreground">{t(def.hintKey)}</span>
                <Tooltip content={`${t(def.detailKey)}${t('textFormat.aiNote')}`} variant="light">
                  <HelpCircle className="h-3.5 w-3.5 shrink-0 cursor-help text-muted-foreground/50 hover:text-muted-foreground" />
                </Tooltip>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
