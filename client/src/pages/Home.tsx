import { useCallback, useEffect, useRef, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { Mic, Clock, Type, Zap } from 'lucide-react'
import { clearStats, estimateTypingTimeSec, getStats, type Stats, getSetting } from '@/services/store'
import * as bridge from '@/services/bridge'
import { SHORTCUTS_CHANGED_EVENT } from '@/services/bridge'
import { refreshRecorderSettings } from '@/services/recorder'
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
  const [statsError, setStatsError] = useState(false)
  const statsRefreshVersion = useRef(0)
  const [isClearStatsDialogOpen, setIsClearStatsDialogOpen] = useState(false)
  const [isClearingStats, setIsClearingStats] = useState(false)
  const [clearStatsError, setClearStatsError] = useState(false)
  const [handsFreeKey, setHandsFreeKey] = useState('AltRight')
  const [pttKey, setPttKey] = useState('ControlRight')

  const refreshStats = useCallback(() => {
    const refreshVersion = ++statsRefreshVersion.current
    void getStats()
      .then((nextStats) => {
        if (refreshVersion !== statsRefreshVersion.current) return
        setStats(nextStats)
        setStatsError(false)
      })
      .catch((error) => {
        if (refreshVersion !== statsRefreshVersion.current) return
        console.error('[home] Failed to load usage stats:', error)
        setStatsError(true)
      })
  }, [])

  useEffect(() => {
    refreshStats()
    const unlistenStats = bridge.listen('stats-updated', refreshStats)

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
      unlistenStats.then((fn) => fn()).catch((error) => console.error('[home] Failed to remove the stats-updated listener:', error))
    }
  }, [refreshStats])

  // Format time display
  const formatTime = (seconds: number) => {
    const totalSeconds = Math.round(seconds)
    const totalMinutes = Math.floor(totalSeconds / 60)
    const remainingSeconds = totalSeconds % 60

    if (totalSeconds < 60) {
      return { value: `${totalSeconds}`, extraValue: null, unit: t('home.unitSeconds'), extraUnit: null }
    }

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
    return {
      value: `${totalMinutes}`,
      extraValue: remainingSeconds > 0 ? `${remainingSeconds}` : null,
      unit: t('home.unitMinutes'),
      extraUnit: remainingSeconds > 0 ? t('home.unitSeconds') : null,
    }
  }

  /** Format large values using the active UI locale. */
  const formatCompactNumber = (num: number) => {
    return new Intl.NumberFormat(getLocale(), {
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(num)
  }

  const unavailableStat = { value: '—', extraValue: null, unit: '', extraUnit: null }
  const totalTime = statsError ? unavailableStat : formatTime(stats.totalDurationSec)
  const avgWordsPerMin = statsError ? unavailableStat.value : stats.totalDurationSec > 60 ? Math.round(stats.totalChars / (stats.totalDurationSec / 60)) : 0
  const savedTime = statsError ? unavailableStat : formatTime(estimateTypingTimeSec(stats.totalChars))

  const handleClearStats = async () => {
    statsRefreshVersion.current += 1
    setIsClearingStats(true)
    setClearStatsError(false)
    try {
      await clearStats()
    } catch (error) {
      console.error('[home] Failed to clear usage stats:', error)
      setClearStatsError(true)
      setIsClearingStats(false)
      return
    }

    // The deletion is committed. Refreshing the recorder's cached personalization profile
    // only affects the next dictation, so a failure here is logged, not reported as a
    // failed clear.
    try {
      await refreshRecorderSettings()
    } catch (error) {
      console.error('[home] Failed to refresh recorder settings after clearing usage stats:', error)
    }
    try {
      await bridge.emit('stats-updated')
    } catch (error) {
      console.error('[home] Failed to emit stats-updated after clearing usage stats:', error)
    }
    refreshStats()
    setIsClearingStats(false)
  }

  const dictation = resolveDictationTrigger(handsFreeKey, pttKey)
  const dictationKeyLabel = dictation.keyLabels.join(' + ')
  const subtitleTemplate = dictation.mode === 'handsFree'
    ? t('home.subtitle')
    : dictation.mode === 'ptt'
      ? t('home.subtitleHold')
      : t('shortcut.unsetHint')

  const cards = [
    { icon: Clock, label: t('home.statTotalTime'), ...totalTime },
    {
      icon: Mic,
      label: t('home.statChars'),
      ...(statsError ? unavailableStat : {
        value: formatCompactNumber(stats.totalChars),
        extraValue: null,
        unit: t('home.unitChars'),
        extraUnit: null,
      }),
    },
    { icon: Zap, label: t('home.statSavedTime'), ...savedTime },
    {
      icon: Type,
      label: t('home.statSpeed'),
      value: avgWordsPerMin,
      extraValue: null,
      unit: statsError ? '' : t('home.unitCharsPerMinute'),
      extraUnit: null,
    },
  ]


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

      {statsError && <p role="alert" className="mb-3 text-sm text-muted-foreground">{t('home.statsUnavailable')}</p>}

      <div className="grid grid-cols-2 gap-4">
        {cards.map(({ icon: Icon, label, value, extraValue, unit, extraUnit }) => (
          <Card key={label}>
            <CardContent className="flex items-center gap-4 p-6">
              <div className="rounded-lg bg-secondary p-3">
                <Icon className="h-5 w-5 text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm text-muted-foreground">{label}</p>
                <div className="mt-0.5 flex items-baseline gap-3 text-foreground">
                  <span className="inline-flex items-baseline gap-1">
                    <span className="text-2xl font-bold tracking-tight tabular-nums">{value}</span>
                    <span className="text-base font-semibold text-foreground/80">{unit}</span>
                  </span>
                  {extraValue && (
                    <span className="inline-flex items-baseline gap-1">
                      <span className="text-2xl font-bold tracking-tight tabular-nums">{extraValue}</span>
                      <span className="text-base font-semibold text-foreground/80">{extraUnit}</span>
                    </span>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="mt-3 flex flex-col items-end gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isClearingStats}
          onClick={() => {
            setClearStatsError(false)
            setIsClearStatsDialogOpen(true)
          }}
        >
          {t('home.clearStats')}
        </Button>
      </div>

      {isClearStatsDialogOpen && (
        <Modal
          title={t('home.clearStatsTitle')}
          onClose={() => setIsClearStatsDialogOpen(false)}
          locked={isClearingStats}
          panelClassName="w-[460px]"
        >
          <div className="mt-3 space-y-3 text-sm leading-relaxed">
            <p className="text-muted-foreground">{t('home.clearStatsIntro')}</p>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              <li>{t('home.clearStatsItemTotals')}</li>
              <li>{t('home.clearStatsItemUsage')}</li>
              <li>{t('home.clearStatsItemProfile')}</li>
            </ul>
            <p className="text-muted-foreground">{t('home.clearStatsKept')}</p>
            <p className="font-medium text-destructive">{t('home.clearStatsIrreversible')}</p>
            {clearStatsError && <p role="alert" className="text-destructive">{t('home.clearStatsError')}</p>}
            <div className="flex items-center justify-end gap-2 pt-1">
              {/* Focus lands on Cancel so Enter or Space right after opening cannot delete anything. */}
              <Button data-modal-autofocus variant="outline" size="sm" disabled={isClearingStats} onClick={() => setIsClearStatsDialogOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button type="button" variant="destructive" size="sm" disabled={isClearingStats} onClick={() => void handleClearStats()}>
                {isClearingStats ? t('home.clearStatsLoading') : t('home.clearStatsConfirmButton')}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      <div className="mt-6">
        <ReportIssueSection />
      </div>
    </div>
  )
}
