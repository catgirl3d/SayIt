import { useEffect, useState, useSyncExternalStore } from 'react'
import { Link } from 'react-router-dom'
import { Monitor, Pause, Play, Square, RefreshCw } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Select, type SelectOption } from '@/components/ui/select'
import { promptPresetDisplayName } from '@/i18n/displayNames'
import { useT } from '@/i18n/useT'
import { DEFAULT_SUBTITLE_TARGET_LANGUAGE } from '@/services/defaults'
import { getPromptPresets, getSetting, setSetting, type PromptPreset } from '@/services/store'
import { getWorkMode } from '@/services/transcription'
import { listSystemAudioDevices, systemAudioSession, type SubtitleTargetLanguage, type SystemAudioDevice, type SystemAudioState } from '@/services/systemAudio'

export type SubtitleAction = 'start' | 'pause' | 'resume' | 'stop'

export function buildTranslationOptions(presets: PromptPreset[]): SelectOption[] {
  return presets
    .filter((preset) => preset.builtin && preset.id.startsWith('translate_'))
    .map((preset) => ({
      value: preset.id.slice('translate_'.length),
      label: promptPresetDisplayName(preset),
    }))
}

export function SystemAudioControls({ state, busy, onAction }: { state: SystemAudioState; busy: boolean; onAction: (action: SubtitleAction) => void }) {
  const t = useT()
  return (
    <div className="flex flex-wrap items-center gap-3">
      {state === 'idle' ? (
        <Button disabled={busy} onClick={() => onAction('start')}><Play className="mr-2 h-4 w-4" />{t('systemAudio.start')}</Button>
      ) : (
        <>
          {state === 'listening' && <Button variant="outline" disabled={busy} onClick={() => onAction('pause')}><Pause className="mr-2 h-4 w-4" />{t('systemAudio.pause')}</Button>}
          {(state === 'paused' || state === 'error') && <Button disabled={busy} onClick={() => onAction('resume')}><Play className="mr-2 h-4 w-4" />{t('systemAudio.resume')}</Button>}
          <Button variant="outline" disabled={state === 'stopping'} onClick={() => onAction('stop')}><Square className="mr-2 h-4 w-4" />{t('systemAudio.stop')}</Button>
        </>
      )}
    </div>
  )
}

export default function SystemAudio() {
  const t = useT()
  const snapshot = useSyncExternalStore(systemAudioSession.subscribe, systemAudioSession.getSnapshot)
  const [devices, setDevices] = useState<SystemAudioDevice[]>([])
  const [deviceId, setDeviceId] = useState('')
  const [targetLanguage, setTargetLanguage] = useState<SubtitleTargetLanguage>(DEFAULT_SUBTITLE_TARGET_LANGUAGE)
  const [translationOptions, setTranslationOptions] = useState<SelectOption[]>([])
  const [ready, setReady] = useState(false)
  const [pending, setPending] = useState(false)
  const [loadError, setLoadError] = useState('')
  const active = snapshot.state !== 'idle'
  const mode = getWorkMode()
  const deviceOptions: SelectOption[] = [
    { value: '', label: t('systemAudio.defaultOutput') },
    ...devices.map((device) => ({ value: device.id, label: device.name })),
  ]
  if (deviceId && !devices.some((device) => device.id === deviceId)) {
    deviceOptions.push({ value: deviceId, label: t('systemAudio.savedNotListed') })
  }

  useEffect(() => {
    let disposed = false
    void Promise.all([
      listSystemAudioDevices(),
      getSetting<string>('systemAudio.deviceId', ''),
      getSetting<SubtitleTargetLanguage>('systemAudio.targetLanguage', DEFAULT_SUBTITLE_TARGET_LANGUAGE),
      getPromptPresets(),
    ]).then(([outputs, savedDevice, language, presets]) => {
      if (disposed) return
      setDevices(outputs)
      setDeviceId(savedDevice)
      const options = buildTranslationOptions(presets)
      setTranslationOptions(options)
      setTargetLanguage(options.some((option) => option.value === language) ? language : DEFAULT_SUBTITLE_TARGET_LANGUAGE)
      setReady(true)
    }).catch(() => { if (!disposed) setLoadError(t('systemAudio.captureFailed')) })
    // Navigation does not own the listening session; only its controls or app teardown stop it.
    return () => { disposed = true }
  }, [])

  const refreshDevices = async () => {
    setPending(true)
    try {
      setDevices(await listSystemAudioDevices())
      setReady(true)
      setLoadError('')
    } catch { setLoadError(t('systemAudio.captureFailed')) } finally { setPending(false) }
  }

  const handleAction = async (action: SubtitleAction) => {
    setPending(true)
    setLoadError('')
    try {
      if (action === 'start') {
        await Promise.all([setSetting('systemAudio.deviceId', deviceId), setSetting('systemAudio.targetLanguage', targetLanguage)])
        await systemAudioSession.start({ deviceId, targetLanguage })
      } else {
        await systemAudioSession[action]()
      }
    } catch { setLoadError(t('systemAudio.notReady')) } finally { setPending(false) }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header>
        <h1 className="mb-2 text-2xl font-bold">{t('systemAudio.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('systemAudio.description')}</p>
      </header>
      <Card>
        <CardContent className="space-y-6 p-6">
          <div className="flex items-center gap-3">
            <Monitor className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
            <p className="text-sm font-medium" role="status">{t(`systemAudio.status.${snapshot.state}`)}</p>
            <span className="ml-auto rounded-md bg-secondary px-2 py-1 text-xs text-muted-foreground">{t(mode === 'local' ? 'mode.local' : mode === 'cloud_api' ? 'mode.cloudApi' : 'mode.server')}</span>
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="min-w-0 space-y-2">
              <label id="subtitle-output-label" className="text-sm font-medium">{t('systemAudio.source')}</label>
              <div className="flex gap-2">
                <Select
                  value={deviceId}
                  onChange={setDeviceId}
                  options={deviceOptions}
                  labelledBy="subtitle-output-label"
                  disabled={active || pending || !ready}
                  className="min-w-0 flex-1"
                />
                <Button variant="outline" size="icon" disabled={active || pending} onClick={() => void refreshDevices()} aria-label={t('systemAudio.refreshDevices')}><RefreshCw className="h-4 w-4" /></Button>
              </div>
            </div>
            <div className="space-y-2">
              <label id="subtitle-language-label" className="text-sm font-medium">{t('systemAudio.targetLanguage')}</label>
              <Select
                value={targetLanguage}
                onChange={setTargetLanguage}
                options={translationOptions}
                labelledBy="subtitle-language-label"
                disabled={active || pending}
                className="w-full"
              />
            </div>
          </div>
          {(snapshot.error || loadError) && <p role="alert" className="text-sm leading-6 text-destructive">{snapshot.error || loadError}</p>}
          {snapshot.warning && <p role="status" className="text-sm leading-6 text-amber-600 dark:text-amber-300">{snapshot.warning}</p>}
          <SystemAudioControls state={snapshot.state} busy={pending || (!ready && !active)} onAction={(action) => void handleAction(action)} />
          {snapshot.caption && <p aria-live="polite" className="whitespace-pre-wrap rounded-lg bg-secondary p-4 text-base leading-7">{snapshot.caption}</p>}
        </CardContent>
      </Card>
      <div className="space-y-3 text-sm leading-6 text-muted-foreground">
        <p>{t('systemAudio.engineHint')} <Link to="/voice-engine" className="text-foreground underline underline-offset-4">{t('nav.voiceEngine')}</Link> / <Link to="/ai-service" className="text-foreground underline underline-offset-4">{t('nav.aiService')}</Link></p>
        <p>{t('systemAudio.mixHint')}</p>
        <p>{t('systemAudio.delayHint')}</p>
        <p>{t('systemAudio.privacyHint')}</p>
      </div>
    </div>
  )
}
