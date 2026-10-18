import * as bridge from '@/services/bridge'
import { useEffect, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { refreshRecorderSettings, setSuppressLateFinalInsertionCache } from '@/services/recorder'
import { getSetting, setSetting } from '@/services/store'
import { setAutomaticUpdateChecksEnabled } from '@/features/update/autoUpdate'
import { Switch } from '@/components/ui/switch'
import { Segmented } from '@/components/ui/segmented'
import AppSection from './AppSection'
import BackupSection from './BackupSection'
import WebDavSection from './WebDavSection'
import { type LanguagePreference, type TranslationKey } from '@/i18n'
import { useT } from '@/i18n/useT'
import { getLanguagePreference, switchLanguage } from '@/stores/language'

const LANGUAGE_OPTIONS = [
  { value: 'auto', labelKey: 'language.auto' },
  { value: 'en', labelKey: 'language.en' },
  { value: 'uk', labelKey: 'language.uk' },
] as const satisfies readonly { value: LanguagePreference; labelKey: TranslationKey }[]

export default function GeneralSettingsPage() {
  const t = useT()
  const [languagePreference, setLanguagePreference] = useState<LanguagePreference>('auto')
  const [autoLaunch, setAutoLaunch] = useState(false)
  const [autoCheckUpdate, setAutoCheckUpdate] = useState(true)
  const [protectClipboard, setProtectClipboard] = useState(true)
  const [historyEnabled, setHistoryEnabled] = useState(true)
  const [suppressLateFinalInsertion, setSuppressLateFinalInsertion] = useState<boolean | null>(null)
  const [suppressLateFinalInsertionSaving, setSuppressLateFinalInsertionSaving] = useState(false)
  const [suppressLateFinalInsertionSaveError, setSuppressLateFinalInsertionSaveError] = useState(false)
  const [audioRetentionEnabled, setAudioRetentionEnabled] = useState(true)
  const [audioRetentionDays, setAudioRetentionDays] = useState(30)
  const [logRetentionDays, setLogRetentionDays] = useState(30)
  const [ready, setReady] = useState(false)
  const [animate, setAnimate] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [launch, clip, history, suppressLateInsertion, retention, audioDays, logDays, autoCheck] = await Promise.all([
        bridge.getAutoLaunch().catch(() => false),
        getSetting('protectClipboard', true).catch(() => true),
        getSetting('historyEnabled', true).catch(() => true),
        getSetting('suppressLateFinalInsertion', false)
          .then((value) => Boolean(value), () => null),
        getSetting('audioRetentionEnabled', true).catch(() => true),
        getSetting('audioRetentionDays', -1).catch(() => -1),
        getSetting('logRetentionDays', 30).catch(() => 30),
        getSetting('autoCheckUpdate', true).catch(() => true),
      ])
      if (cancelled) return
      setAutoLaunch(Boolean(launch))
      setAutoCheckUpdate(Boolean(autoCheck))
      setProtectClipboard(Boolean(clip))
      setHistoryEnabled(Boolean(history))
      setSuppressLateFinalInsertion(suppressLateInsertion)
      setAudioRetentionEnabled(Boolean(retention))
      const ad = Number(audioDays)
      if (ad === 7 || ad === 30 || ad === 90 || ad === -1) setAudioRetentionDays(ad)
      const ld = Number(logDays)
      if (ld === 7 || ld === 15 || ld === 30 || ld === 90) setLogRetentionDays(ld)
      setReady(true)
      // Double rAF ensures the DOM has fully rendered initial switch/segmented states
      // before enabling transition animations, preventing jarring layout shifts on initial mount.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!cancelled) setAnimate(true)
      }))
    })()

    getLanguagePreference().then(setLanguagePreference).catch(() => { })
    return () => { cancelled = true }
  }, [])

  const handleLanguageChange = async (next: LanguagePreference) => {
    const previous = languagePreference
    setLanguagePreference(next)
    try {
      await switchLanguage(next)
    } catch {
      setLanguagePreference(previous)
      await switchLanguage(previous).catch(() => { })
    }
  }

  const toggleAutoLaunch = async () => {
    const next = !autoLaunch
    setAutoLaunch(next)
    await bridge.setAutoLaunch(next)
  }

  /**
   * Optimistic toggle with rollback: the service persists the preference and moves
   * the check timer; if persistence fails the UI must not keep claiming a state the
   * stored truth does not have.
   */
  const toggleAutoCheckUpdate = async () => {
    const previous = autoCheckUpdate
    const next = !previous
    setAutoCheckUpdate(next)
    try {
      await setAutomaticUpdateChecksEnabled(next)
    } catch {
      setAutoCheckUpdate(previous)
    }
  }

  const toggleProtectClipboard = async () => {
    const next = !protectClipboard
    setProtectClipboard(next)
    await setSetting('protectClipboard', next)
    await refreshRecorderSettings()
  }

  const toggleHistory = async () => {
    const next = !historyEnabled
    setHistoryEnabled(next)
    await setSetting('historyEnabled', next)
  }

  const toggleSuppressLateFinalInsertion = async () => {
    if (suppressLateFinalInsertion === null || suppressLateFinalInsertionSaving) return
    const next = !suppressLateFinalInsertion
    setSuppressLateFinalInsertionSaving(true)
    setSuppressLateFinalInsertionSaveError(false)
    try {
      await setSetting('suppressLateFinalInsertion', next)
      setSuppressLateFinalInsertionCache(next)
      setSuppressLateFinalInsertion(next)
    } catch {
      setSuppressLateFinalInsertionSaveError(true)
    } finally {
      setSuppressLateFinalInsertionSaving(false)
    }
  }

  const toggleAudioRetention = async () => {
    const next = !audioRetentionEnabled
    setAudioRetentionEnabled(next)
    await setSetting('audioRetentionEnabled', next)
  }

  const handleAudioRetentionDaysChange = async (days: number) => {
    setAudioRetentionDays(days)
    await setSetting('audioRetentionDays', days)
  }

  const handleLogRetentionDaysChange = async (days: number) => {
    setLogRetentionDays(days)
    await setSetting('logRetentionDays', days)
  }

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-6 text-2xl font-bold">{t('nav.general')}</h1>
      <div className="space-y-6">
        {/* Interface language */}
        <Card>
          <CardContent className="p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold">{t('settings.general.language.title')}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{t('settings.general.language.hint')}</p>
              </div>
              <div className="shrink-0" style={ready ? undefined : { visibility: 'hidden' }}>
                <Segmented
                  label={t('settings.general.language.title')}
                  value={languagePreference}
                  options={LANGUAGE_OPTIONS.map((opt) => ({ value: opt.value, label: t(opt.labelKey) }))}
                  onChange={(value) => void handleLanguageChange(value)}
                  animated={animate}
                  className="justify-end"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* System preferences */}
        <Card>
          <CardContent className="space-y-4 p-6">
            <h2 className="text-lg font-semibold">{t('settings.prefs.title')}</h2>
            <div className="flex items-center justify-between">
              <div>
                <p id="protect-clipboard-label" className="text-sm font-medium">{t('settings.prefs.protectClipboard')}</p>
                <p className="text-xs text-muted-foreground">{t('settings.prefs.protectClipboardDesc')}</p>
              </div>
              <Switch labelledBy="protect-clipboard-label" checked={protectClipboard} onChange={() => void toggleProtectClipboard()} noAnimation={!animate} hidden={!ready} />
            </div>
          </CardContent>
        </Card>

        {/* History and storage */}
        <Card>
          <CardContent className="space-y-4 p-6">
            <h2 id="history-heading" className="text-lg font-semibold">{t('settings.history.title')}</h2>
            <div className="flex items-center justify-between">
              <div>
                <p id="history-enable-label" className="text-sm font-medium">{t('settings.history.enable')}</p>
                <p className="text-xs text-muted-foreground">{t('settings.history.desc')}</p>
              </div>
              <Switch labelledBy="history-enable-label" checked={historyEnabled} onChange={() => void toggleHistory()} noAnimation={!animate} hidden={!ready} />
            </div>

            <div className="flex items-center justify-between border-t border-border pt-4">
              <div>
                <p id="history-late-insertion-label" className="text-sm font-medium">{t('settings.history.suppressLateInsertion')}</p>
                <p className="text-xs text-muted-foreground">{t('settings.history.suppressLateInsertionDesc')}</p>
              </div>
              {suppressLateFinalInsertion === null ? (
                ready && <p role="status" className="text-xs text-muted-foreground">{t('settings.history.suppressLateInsertionUnavailable')}</p>
              ) : (
                <Switch
                  labelledBy="history-late-insertion-label"
                  checked={suppressLateFinalInsertion}
                  onChange={() => void toggleSuppressLateFinalInsertion()}
                  disabled={suppressLateFinalInsertionSaving}
                  noAnimation={!animate}
                  hidden={!ready}
                />
              )}
            </div>
            {suppressLateFinalInsertionSaveError && (
              <p role="alert" className="text-xs text-destructive">{t('settings.history.suppressLateInsertionSaveError')}</p>
            )}

            <div className="flex items-center justify-between border-t border-border pt-4">
              <div>
                <p id="audio-retention-label" className="text-sm font-medium">{t('settings.audio.title')}</p>
                <p className="text-xs text-muted-foreground">{t('settings.audio.desc')}</p>
              </div>
              <Switch labelledBy="audio-retention-label" checked={audioRetentionEnabled} onChange={() => void toggleAudioRetention()} noAnimation={!animate} hidden={!ready} />
            </div>

            {audioRetentionEnabled && (
              <div className="flex items-center justify-between border-t border-border pt-4">
                <div>
                  <p className="text-sm font-medium">{t('settings.audio.retentionLabel')}</p>
                </div>
                <Segmented
                  label={t('settings.audio.retentionLabel')}
                  value={audioRetentionDays}
                  options={[
                    { value: 7, label: t('settings.retention.7d') },
                    { value: 30, label: t('settings.retention.1m') },
                    { value: 90, label: t('settings.retention.3m') },
                    { value: -1, label: t('settings.retention.forever') },
                  ]}
                  onChange={(v) => void handleAudioRetentionDaysChange(Number(v))}
                  size="sm"
                  animated={animate}
                  className="justify-end"
                />
              </div>
            )}

            <div className="flex items-center justify-between border-t border-border pt-4">
              <div>
                <p className="text-sm font-medium">{t('settings.log.title')}</p>
                <p className="text-xs text-muted-foreground">{t('settings.log.desc')}</p>
              </div>
              <Segmented
                label={t('settings.log.title')}
                value={logRetentionDays}
                options={[
                  { value: 7, label: t('settings.retention.7d') },
                  { value: 15, label: t('settings.retention.15d') },
                  { value: 30, label: t('settings.retention.1m') },
                  { value: 90, label: t('settings.retention.3m') },
                ]}
                onChange={(v) => void handleLogRetentionDaysChange(Number(v))}
                size="sm"
                animated={animate}
                className="justify-end"
              />
            </div>
          </CardContent>
        </Card>

        {/* Launch at startup */}
        <AppSection
          autoLaunch={autoLaunch}
          onToggleAutoLaunch={toggleAutoLaunch}
          autoCheckUpdate={autoCheckUpdate}
          onToggleAutoCheckUpdate={toggleAutoCheckUpdate}
          ready={ready}
          animate={animate}
        />

        {/* Backup and restore */}
        <BackupSection />
        <WebDavSection />
      </div>
    </div>
  )
}
