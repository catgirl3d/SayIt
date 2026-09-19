import { useEffect, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Mic, Clock, Type, Zap } from 'lucide-react'
import { getStats, type Stats, getSetting } from '@/services/store'
import * as bridge from '@/services/bridge'
import { SHORTCUTS_CHANGED_EVENT } from '@/services/bridge'
import ReportIssueSection from '@/components/ReportIssueSection'
import NoticeBanner from '@/components/NoticeBanner'
import { resolveDictationTrigger } from '@/lib/shortcutKeys'
import { getLocale } from '@/i18n'
import { useT } from '@/i18n/useT'

/**
 * Renders a `{key}` template as "text + keycap + text".
 *
 * The whole sentence cannot just go through one t() call: the keycap is a styled
 * <span>, and its position differs between languages ("press X to start" vs
 * "Натисніть X"). Splitting on the placeholder lets each translation choose the
 * position without a language-specific JSX branch.
 *
 * An empty keyLabel means the template has no usable key to show: render the text
 * alone instead of leaving an empty keycap in the sentence.
 */
function WithKeyChip({
  template,
  keyLabel,
  chipClassName,
}: {
  template: string
  keyLabel: string
  chipClassName: string
}) {
  if (!keyLabel) return <>{template}</>
  const [before, after = ''] = template.split('{key}')
  return (
    <>
      {before}
      <span className={chipClassName}>{keyLabel}</span>
      {after}
    </>
  )
}

export default function Home() {
  const t = useT()
  const [stats, setStats] = useState<Stats>({ totalDurationSec: 0, totalChars: 0 })
  const [handsFreeKey, setHandsFreeKey] = useState('AltRight')
  const [pttKey, setPttKey] = useState('ControlRight')

  useEffect(() => {
    const refreshStats = () => void getStats().then(setStats)
    refreshStats()
    const unlistenStats = bridge.listen('stats-updated', refreshStats)
    const unlistenHistory = bridge.listen('history-updated', refreshStats)

    const loadShortcutKeys = () =>
      Promise.all([
        getSetting('shortcutHandsFree', 'AltRight'),
        getSetting('shortcutPTT', 'ControlRight'),
      ]).then(([handsFree, ptt]) => {
        setHandsFreeKey(handsFree as string)
        setPttKey(ptt as string)
      })
    void loadShortcutKeys()
    // Refresh the hint live when shortcuts change (wizard / settings page), without a route switch.
    window.addEventListener(SHORTCUTS_CHANGED_EVENT, loadShortcutKeys)
    return () => {
      window.removeEventListener(SHORTCUTS_CHANGED_EVENT, loadShortcutKeys)
      unlistenStats.then((fn) => fn()).catch(() => {})
      unlistenHistory.then((fn) => fn()).catch(() => {})
    }
  }, [])

  // Format time display
  const formatTime = (seconds: number) => {
    const totalMinutes = Math.round(seconds / 60)
    if (totalMinutes >= 60) {
      const hours = Math.floor(totalMinutes / 60)
      const minutes = totalMinutes % 60
      return {
        value: `${hours}`,
        extraValue: minutes > 0 ? `${minutes}` : null,
        unit: t('home.unitHours'),
        extraUnit: minutes > 0 ? t('home.unitMinutes') : null,
      }
    }
    return { value: `${totalMinutes}`, extraValue: null, unit: t('home.unitMinutes'), extraUnit: null }
  }

  /** Format large values using the active UI locale. */
  const formatCompactNumber = (num: number) => {
    return new Intl.NumberFormat(getLocale(), {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(num)
  }

  const totalTime = formatTime(stats.totalDurationSec)
  const avgWordsPerMin = stats.totalDurationSec > 60 ? Math.round(stats.totalChars / (stats.totalDurationSec / 60)) : 0
  const savedTime = formatTime(Math.round(stats.totalChars / 50) * 60)

  const dictation = resolveDictationTrigger(handsFreeKey, pttKey)
  const dictationKeyLabel = dictation.keyLabels.join(' + ')
  const subtitleTemplate = dictation.mode === 'handsFree'
    ? t('home.subtitle')
    : dictation.mode === 'ptt'
      ? t('home.subtitleHold')
      : t('shortcut.unsetHint')
  const newUserHintTemplate = dictation.mode === 'handsFree'
    ? t('home.newUserHint')
    : t('home.newUserHintHold')

  const cards = [
    { icon: Clock, label: t('home.statTotalTime'), ...totalTime },
    {
      icon: Mic,
      label: t('home.statChars'),
      value: formatCompactNumber(stats.totalChars),
      extraValue: null,
      unit: t('home.unitChars'),
      extraUnit: null,
    },
    { icon: Zap, label: t('home.statSavedTime'), ...savedTime },
    {
      icon: Type,
      label: t('home.statSpeed'),
      value: `${avgWordsPerMin}`,
      extraValue: null,
      unit: t('home.unitCharsPerMinute'),
      extraUnit: null,
    },
  ]

  const isNewUser = stats.totalDurationSec === 0 && stats.totalChars === 0

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="mb-4 text-2xl font-bold">{t('home.title')}</h1>
      <p className="mb-8 text-sm text-muted-foreground">
        <WithKeyChip
          template={subtitleTemplate}
          keyLabel={dictationKeyLabel}
          chipClassName="px-1.5 py-0.5 text-muted-foreground bg-secondary border border-border rounded"
        />
      </p>

      <NoticeBanner />

      {isNewUser && dictation.mode !== 'none' && (
        <div className="mb-6 rounded-xl border border-border bg-muted/30 px-5 py-5 text-center">
          <p className="text-sm text-muted-foreground">
            <WithKeyChip
              template={newUserHintTemplate}
              keyLabel={dictationKeyLabel}
              chipClassName="px-1.5 py-0.5 text-muted-foreground bg-secondary border border-border rounded text-xs"
            />
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        {cards.map(({ icon: Icon, label, value, extraValue, unit, extraUnit }) => (
          <Card key={label}>
            <CardContent className="flex items-center gap-4 p-6">
              <div className="rounded-lg bg-secondary p-3">
                <Icon className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">{label}</p>
                <p className="text-2xl font-bold">
                  {value} <span className="text-sm font-normal text-muted-foreground">{unit}</span>
                  {extraValue && (
                    <>
                      {' '}
                      {extraValue} <span className="text-sm font-normal text-muted-foreground">{extraUnit}</span>
                    </>
                  )}
                </p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="mt-6">
        <ReportIssueSection />
      </div>
    </div>
  )
}
