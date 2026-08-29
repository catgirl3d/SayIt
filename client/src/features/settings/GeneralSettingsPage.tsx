import * as bridge from '@/services/bridge'
import { useEffect, useState } from 'react'
import { Pencil, RotateCcw } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Modal } from '@/components/ui/modal'
import { refreshRecorderSettings } from '@/services/recorder'
import { getSetting, setSetting } from '@/services/store'
import { Switch } from '@/components/ui/switch'
import { Segmented } from '@/components/ui/segmented'
import AppSection from './AppSection'
import BackupSection from './BackupSection'
import { type LanguagePreference, type TranslationKey } from '@/i18n'
import { useT } from '@/i18n/useT'
import { getLanguagePreference, switchLanguage } from '@/stores/language'
import {
  CONTEXT_SELECTION_EDIT_PROMPT,
  CONTEXT_SELECTION_EDIT_PROMPT_SETTING_KEY,
  normalizeContextSelectionEditPrompt,
} from '@/services/contextAware'

const LANGUAGE_OPTIONS = [
  { value: 'auto', labelKey: 'language.auto' },
  { value: 'zh-CN', labelKey: 'language.zhCN' },
  { value: 'en', labelKey: 'language.en' },
] as const satisfies readonly { value: LanguagePreference; labelKey: TranslationKey }[]

export default function GeneralSettingsPage() {
  const t = useT()
  const [languagePreference, setLanguagePreference] = useState<LanguagePreference>('auto')
  const [autoLaunch, setAutoLaunch] = useState(false)
  const [protectClipboard, setProtectClipboard] = useState(true)
  const [contextAwareWriting, setContextAwareWriting] = useState(false)
  const [contextPromptOpen, setContextPromptOpen] = useState(false)
  const [contextSelectionEditPrompt, setContextSelectionEditPrompt] = useState(CONTEXT_SELECTION_EDIT_PROMPT)
  const [contextPromptDraft, setContextPromptDraft] = useState(CONTEXT_SELECTION_EDIT_PROMPT)
  const [contextPromptSaving, setContextPromptSaving] = useState(false)
  const [historyEnabled, setHistoryEnabled] = useState(true)
  const [audioRetentionEnabled, setAudioRetentionEnabled] = useState(true)
  const [audioRetentionDays, setAudioRetentionDays] = useState(30)
  const [logRetentionDays, setLogRetentionDays] = useState(30)
  const [ready, setReady] = useState(false)
  const [animate, setAnimate] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [launch, clip, contextAware, history, retention, audioDays, logDays] = await Promise.all([
        bridge.getAutoLaunch().catch(() => false),
        getSetting('protectClipboard', true).catch(() => true),
        getSetting('contextAwareWritingEnabled', false).catch(() => false),
        getSetting('historyEnabled', true).catch(() => true),
        getSetting('audioRetentionEnabled', true).catch(() => true),
        getSetting('audioRetentionDays', -1).catch(() => -1),
        getSetting('logRetentionDays', 30).catch(() => 30),
      ])
      if (cancelled) return
      setAutoLaunch(Boolean(launch))
      setProtectClipboard(Boolean(clip))
      setContextAwareWriting(Boolean(contextAware))
      setHistoryEnabled(Boolean(history))
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
    getSetting(CONTEXT_SELECTION_EDIT_PROMPT_SETTING_KEY, CONTEXT_SELECTION_EDIT_PROMPT)
      .then((v) => {
        const p = normalizeContextSelectionEditPrompt(v)
        setContextSelectionEditPrompt(p)
        setContextPromptDraft(p)
      })
      .catch(() => { })
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

  const toggleProtectClipboard = async () => {
    const next = !protectClipboard
    setProtectClipboard(next)
    await setSetting('protectClipboard', next)
    await refreshRecorderSettings()
  }

  const toggleContextAwareWriting = async () => {
    const next = !contextAwareWriting
    setContextAwareWriting(next)
    await setSetting('contextAwareWritingEnabled', next)
    await refreshRecorderSettings()
  }

  const openContextPrompt = () => {
    setContextPromptDraft(contextSelectionEditPrompt)
    setContextPromptOpen(true)
  }

  const saveContextPrompt = async () => {
    const prompt = contextPromptDraft.trim()
    if (!prompt || contextPromptSaving) return
    setContextPromptSaving(true)
    const normalized = normalizeContextSelectionEditPrompt(prompt)
    try {
      await setSetting(CONTEXT_SELECTION_EDIT_PROMPT_SETTING_KEY, normalized)
      setContextSelectionEditPrompt(normalized)
      setContextPromptDraft(normalized)
      await refreshRecorderSettings()
      setContextPromptOpen(false)
    } finally {
      setContextPromptSaving(false)
    }
  }

  const resetContextPrompt = () => {
    setContextPromptDraft(CONTEXT_SELECTION_EDIT_PROMPT)
  }

  const toggleHistory = async () => {
    const next = !historyEnabled
    setHistoryEnabled(next)
    await setSetting('historyEnabled', next)
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

        {/* Selection editing */}
        <Card>
          <CardContent className="space-y-4 p-6">
            <h2 id="context-aware-heading" className="text-lg font-semibold">{t('settings.contextAware.title')}</h2>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">{t('settings.contextAware.descContinue')}</p>
              </div>
              <Switch labelledBy="context-aware-heading" checked={contextAwareWriting} onChange={() => void toggleContextAwareWriting()} noAnimation={!animate} hidden={!ready} />
            </div>

            <div className="flex items-center justify-between border-t border-border pt-4">
              <div>
                <p className="text-sm font-medium">{t('settings.contextAware.promptTitle')}</p>
                <p className="text-xs text-muted-foreground">{t('settings.contextAware.promptDesc')}</p>
              </div>
              <button
                type="button"
                onClick={openContextPrompt}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Pencil className="h-3.5 w-3.5" />
                {t('settings.contextAware.editPrompt')}
              </button>
            </div>
          </CardContent>
        </Card>

        {/* History and storage */}
        <Card>
          <CardContent className="space-y-4 p-6">
            <h2 id="history-heading" className="text-lg font-semibold">{t('settings.history.title')}</h2>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">{t('settings.history.desc')}</p>
              </div>
              <Switch labelledBy="history-heading" checked={historyEnabled} onChange={() => void toggleHistory()} noAnimation={!animate} hidden={!ready} />
            </div>

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
        <AppSection autoLaunch={autoLaunch} onToggleAutoLaunch={toggleAutoLaunch} ready={ready} animate={animate} />

        {/* Backup and restore */}
        <BackupSection />
      </div>

      {/* Selection-editing prompt dialog */}
      {contextPromptOpen && (
        <Modal onClose={() => setContextPromptOpen(false)} title={t('settings.contextAware.promptTitle')}>
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">{t('settings.contextAware.promptDesc')}</p>
            <textarea
              value={contextPromptDraft}
              onChange={(e) => setContextPromptDraft(e.target.value)}
              rows={8}
              className="w-full rounded-md border border-border bg-input p-3 text-xs leading-relaxed text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none"
              placeholder={CONTEXT_SELECTION_EDIT_PROMPT}
            />
            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                onClick={resetContextPrompt}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t('settings.contextAware.resetPrompt')}
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setContextPromptOpen(false)}
                  className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => void saveContextPrompt()}
                  disabled={contextPromptSaving || !contextPromptDraft.trim()}
                  className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {contextPromptSaving ? t('settings.contextAware.savingPrompt') : t('common.save')}
                </button>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
