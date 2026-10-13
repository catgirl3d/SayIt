import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Link } from 'react-router-dom'
import { Monitor, Pause, Play, Square, RefreshCw } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import SpeechLanguageSelect from '@/components/SpeechLanguageSelect'
import { Select, type SelectOption } from '@/components/ui/select'
import { getLocale } from '@/i18n'
import { promptPresetDisplayName } from '@/i18n/displayNames'
import { useLocale, useT } from '@/i18n/useT'
import { getPromptPresets, getSetting, setSetting, TRANSLATION_PRESET_PREFIX, type PromptPreset } from '@/services/store'
import * as bridge from '@/services/bridge'
import { open } from '@tauri-apps/plugin-dialog'
import { getWorkMode } from '@/services/transcription'
import { loadActiveAsrProfile } from '@/features/settings/asrProfileStore'
import { addRuntimeEvent } from '@/services/debugLog'
import { isLiveRecognitionProvider } from '@/lib/asrModels'
import type { SpeechInputLanguage } from '@/services/speechInputLanguage'
import { getSystemAudioDualSubtitles, getSystemAudioMaxSegmentSeconds, getSystemAudioSourceLanguage, listSystemAudioDevices, systemAudioSession, type SubtitleTargetLanguage, type SystemAudioDevice, type SystemAudioState } from '@/services/systemAudio'
import { DEFAULT_SEGMENT_SECONDS, MAX_SEGMENT_SECONDS, MIN_SEGMENT_SECONDS, SEGMENT_SECONDS_STEP } from '@/services/subtitleSegmentation'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { setPipelineDebugEnabled } from '@/services/pipelineTrace'
import PipelineDebugPanel from '@/features/systemAudio/PipelineDebugPanel'

export type SubtitleAction = 'start' | 'pause' | 'resume' | 'stop'

export function buildTranslationOptions(presets: PromptPreset[]): SelectOption[] {
  return presets
    .filter((preset) => preset.builtin && preset.id.startsWith(TRANSLATION_PRESET_PREFIX))
    .map((preset) => ({
      value: preset.id.slice(TRANSLATION_PRESET_PREFIX.length),
      label: promptPresetDisplayName(preset),
    }))
}

export function defaultSubtitleTargetLanguage(options: SelectOption[], locale: string = getLocale()): string {
  return options.find((option) => option.value === locale)?.value ?? options[0]?.value ?? ''
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
  const [sourceLanguage, setSourceLanguage] = useState<SpeechInputLanguage>('auto')
  const [targetLanguage, setTargetLanguage] = useState<SubtitleTargetLanguage>('')
  const [maxSegmentSeconds, setMaxSegmentSeconds] = useState(DEFAULT_SEGMENT_SECONDS)
  const [presets, setPresets] = useState<PromptPreset[]>([])
  const [ready, setReady] = useState(false)
  const [pending, setPending] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [pipelineDebugEnabled, setPipelineDebugEnabledState] = useState(false)
  const [asrOnlyTest, setAsrOnlyTest] = useState(false)
  const [dualSubtitles, setDualSubtitles] = useState(false)
  const [transcriptEnabled, setTranscriptEnabled] = useState(false)
  const [transcriptReady, setTranscriptReady] = useState(false)
  const [transcriptDir, setTranscriptDir] = useState('')
  const [transcriptDirDisplay, setTranscriptDirDisplay] = useState('')
  const [transcriptError, setTranscriptError] = useState('')
  const [liveRecognitionEnabled, setLiveRecognitionEnabled] = useState(false)
  const [liveRecognitionReady, setLiveRecognitionReady] = useState(false)
  const [liveRecognitionError, setLiveRecognitionError] = useState('')
  const [activeAsrProvider, setActiveAsrProvider] = useState('')
  const locale = useLocale()
  // Derive option labels from the loaded presets on every locale change; they are not stored in state.
  const translationOptions = useMemo(() => buildTranslationOptions(presets), [presets, locale])
  const active = snapshot.state !== 'idle'
  const error = snapshot.error || loadError || liveRecognitionError || transcriptError
  const mode = getWorkMode()
  // Mirrors the runtime gate: live recognition is implemented only by CloudAPIProvider, and only
  // the Deepgram profile can open it; every other engine keeps batch recognition, so the page must
  // not offer the setting at all.
  const liveRecognitionSupported = mode === 'cloud_api' && isLiveRecognitionProvider(activeAsrProvider)
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
      getSystemAudioSourceLanguage(),
      getSetting<SubtitleTargetLanguage>('systemAudio.targetLanguage', ''),
      getPromptPresets(),
      getSetting<boolean>('systemAudio.debugPipeline', false),
      getSetting<boolean>('systemAudio.asrOnlyTest', false),
      getSystemAudioMaxSegmentSeconds(),
      getSystemAudioDualSubtitles(),
      getSetting<boolean>('systemAudio.liveRecognitionEnabled', false).then((savedLiveRecognitionEnabled) => {
        if (!disposed) {
          setLiveRecognitionEnabled(savedLiveRecognitionEnabled)
          setLiveRecognitionReady(true)
        }
        return savedLiveRecognitionEnabled
      }),
      getSetting<boolean>('systemAudio.transcriptEnabled', false).then((savedTranscriptEnabled) => {
        if (!disposed) {
          setTranscriptEnabled(savedTranscriptEnabled)
          setTranscriptReady(true)
        }
        return savedTranscriptEnabled
      }),
      getSetting<string>('systemAudio.transcriptDir', '').then(async (savedTranscriptDir) => {
        if (!disposed) setTranscriptDir(savedTranscriptDir)
        try {
          // Display only: a failed resolution must not break the rest of the page load.
          const resolved = await bridge.resolveSubtitleTranscriptDir(savedTranscriptDir)
          if (!disposed) setTranscriptDirDisplay(resolved)
        } catch (error: unknown) {
          addRuntimeEvent('warn', 'system-audio', 'Could not resolve the transcript folder for display', { error: String(error) })
        }
        return savedTranscriptDir
      }),
    ]).then(([outputs, savedDevice, savedSourceLanguage, language, presets, debugPipeline, asrOnly, savedMaxSegmentSeconds, savedDualSubtitles]) => {
      if (disposed) return
      setDevices(outputs)
      setDeviceId(savedDevice)
      setSourceLanguage(savedSourceLanguage)
      setMaxSegmentSeconds(savedMaxSegmentSeconds)
      setDualSubtitles(savedDualSubtitles)
      setPipelineDebugEnabledState(debugPipeline)
      setPipelineDebugEnabled(debugPipeline)
      setAsrOnlyTest(asrOnly)
      const options = buildTranslationOptions(presets)
      setPresets(presets)
      setTargetLanguage(options.some((option) => option.value === language) ? language : defaultSubtitleTargetLanguage(options))
      setReady(true)
    }).catch(() => { if (!disposed) setLoadError(t('systemAudio.captureFailed')) })
    // Resolved independently from the settings batch: a slow saved switch value must not delay
    // knowing whether this engine supports live recognition.
    void loadActiveAsrProfile().then((activeProfile) => {
      if (!disposed) setActiveAsrProvider(activeProfile?.provider ?? '')
    }).catch((error: unknown) => {
      addRuntimeEvent('warn', 'system-audio', 'Failed to load the active ASR profile for live-recognition support', { error: String(error) })
    })
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

  const chooseTranscriptFolder = async () => {
    setTranscriptError('')
    try {
      const picked = await open({ directory: true, multiple: false, defaultPath: transcriptDirDisplay || undefined })
      if (typeof picked !== 'string') return
      await setSetting('systemAudio.transcriptDir', picked)
      setTranscriptDir(picked)
      setTranscriptDirDisplay(await bridge.resolveSubtitleTranscriptDir(picked))
    } catch { setTranscriptError(t('systemAudio.transcriptFolderFailed')) }
  }

  const openTranscriptFolder = async () => {
    setTranscriptError('')
    try {
      await bridge.openSubtitleTranscriptFolder(transcriptDir)
    } catch { setTranscriptError(t('systemAudio.transcriptFolderFailed')) }
  }

  const handleAction = async (action: SubtitleAction) => {
    setPending(true)
    setLoadError('')
    try {
      if (action === 'start') {
        await systemAudioSession.start({ deviceId, targetLanguage, asrOnly: asrOnlyTest })
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
          <div className="min-w-0 space-y-2">
            <label id="subtitle-output-label" className="text-sm font-medium">{t('systemAudio.source')}</label>
            <div className="flex gap-2">
              <Select
                value={deviceId}
                onChange={(value) => {
                  setDeviceId(value)
                  void setSetting('systemAudio.deviceId', value)
                }}
                options={deviceOptions}
                labelledBy="subtitle-output-label"
                disabled={active || pending || !ready}
                className="min-w-0 flex-1"
              />
              <Button variant="outline" size="icon" disabled={active || pending} onClick={() => void refreshDevices()} aria-label={t('systemAudio.refreshDevices')}><RefreshCw className="h-4 w-4" /></Button>
            </div>
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="space-y-2">
              <label id="subtitle-source-language-label" className="text-sm font-medium">{t('systemAudio.sourceLanguage')}</label>
              <SpeechLanguageSelect
                value={sourceLanguage}
                onChange={(value) => {
                  setSourceLanguage(value)
                  void setSetting('systemAudio.sourceLanguage', value)
                }}
                labelledBy="subtitle-source-language-label"
                disabled={active || pending}
                className="w-full"
              />
            </div>
            <div className="space-y-2">
              <label id="subtitle-language-label" className="text-sm font-medium">{t('systemAudio.targetLanguage')}</label>
              <Select
                value={targetLanguage}
                onChange={(value) => {
                  setTargetLanguage(value)
                  void setSetting('systemAudio.targetLanguage', value)
                }}
                options={translationOptions}
                labelledBy="subtitle-language-label"
                disabled={active || pending || asrOnlyTest}
                className="w-full"
              />
            </div>
          </div>
          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-3">
              <label id="subtitle-segment-length-label" className="text-sm font-medium">{t('systemAudio.segmentLength')}</label>
              <span className="text-sm tabular-nums text-muted-foreground">{t('duration.seconds', { count: maxSegmentSeconds })}</span>
            </div>
            <Slider
              value={maxSegmentSeconds}
              min={MIN_SEGMENT_SECONDS}
              max={MAX_SEGMENT_SECONDS}
              step={SEGMENT_SECONDS_STEP}
              onChange={(value) => {
                setMaxSegmentSeconds(value)
                void setSetting('systemAudio.maxSegmentSec', value)
              }}
              labelledBy="subtitle-segment-length-label"
              valueText={t('duration.seconds', { count: maxSegmentSeconds })}
              disabled={active || pending}
            />
            <div className="flex justify-between text-xs text-muted-foreground" aria-hidden>
              <span>{t('duration.seconds', { count: MIN_SEGMENT_SECONDS })}</span>
              <span>{t('duration.seconds', { count: MAX_SEGMENT_SECONDS })}</span>
            </div>
            <p className="text-xs text-muted-foreground">{t('systemAudio.segmentLengthHint')}</p>
            {liveRecognitionSupported && liveRecognitionEnabled && <p className="text-xs text-muted-foreground">{t('systemAudio.liveTargetHelp')}</p>}
          </div>
          {liveRecognitionSupported && (
            <div className="space-y-1">
              <Switch
                checked={liveRecognitionEnabled}
                onChange={() => {
                  if (!liveRecognitionReady || active || pending) return
                  const enabled = !liveRecognitionEnabled
                  setPending(true)
                  void setSetting('systemAudio.liveRecognitionEnabled', enabled).then(() => {
                    setLiveRecognitionEnabled(enabled)
                    setLiveRecognitionError('')
                  }).catch(() => {
                    setLiveRecognitionError(t('systemAudio.captureFailed'))
                  }).finally(() => { setPending(false) })
                }}
                label={t('systemAudio.liveRecognitionLabel')}
                disabled={!liveRecognitionReady || active || pending}
              />
              <p className="text-xs text-muted-foreground">{t('systemAudio.liveRecognitionHelp')}</p>
            </div>
          )}
          <div className="space-y-1">
            <Switch
              checked={dualSubtitles}
              onChange={() => {
                const enabled = !dualSubtitles
                setDualSubtitles(enabled)
                void setSetting('systemAudio.dualSubtitles', enabled)
              }}
              label={t('systemAudio.dualSubtitles')}
              disabled={active || pending || asrOnlyTest}
            />
            <p className="text-xs text-muted-foreground">{t('systemAudio.dualSubtitlesHint')}</p>
          </div>
          <div className="space-y-1">
            <Switch
              checked={transcriptEnabled}
              onChange={() => {
                if (!transcriptReady || active || pending) return
                const enabled = !transcriptEnabled
                setPending(true)
                void setSetting('systemAudio.transcriptEnabled', enabled).then(() => {
                  setTranscriptEnabled(enabled)
                  setTranscriptError('')
                }).catch(() => {
                  setTranscriptError(t('systemAudio.transcriptSettingFailed'))
                }).finally(() => { setPending(false) })
              }}
              label={t('systemAudio.transcriptLabel')}
              disabled={!transcriptReady || active || pending}
            />
            <p className="text-xs text-muted-foreground">{t('systemAudio.transcriptHelp')}</p>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="text-xs text-muted-foreground">{t('systemAudio.transcriptFolderLabel')}:</span>
              <span className="min-w-0 flex-1 truncate text-xs" title={transcriptDirDisplay}>{transcriptDirDisplay}</span>
              <Button variant="outline" size="sm" disabled={!transcriptReady || active || pending} onClick={() => void chooseTranscriptFolder()}>
                {t('systemAudio.transcriptChoose')}
              </Button>
              <Button variant="outline" size="sm" disabled={!transcriptReady || active || pending} onClick={() => void openTranscriptFolder()}>
                {t('systemAudio.transcriptOpen')}
              </Button>
            </div>
          </div>
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={pipelineDebugEnabled}
                  onChange={(event) => {
                    const enabled = event.target.checked
                    setPipelineDebugEnabledState(enabled)
                    setPipelineDebugEnabled(enabled)
                    void setSetting('systemAudio.debugPipeline', enabled)
                  }}
                  className="rounded"
                />
                {t('systemAudio.debug.toggle')}
              </label>
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={asrOnlyTest}
                  disabled={active || pending}
                  onChange={(event) => {
                    const enabled = event.target.checked
                    setAsrOnlyTest(enabled)
                    void setSetting('systemAudio.asrOnlyTest', enabled)
                  }}
                  className="rounded"
                />
                {t('systemAudio.asrOnlyTest')}
              </label>
            </div>
            <p className="text-xs text-muted-foreground">{t('systemAudio.asrOnlyHint')}</p>
          </div>
          {error && <p role="alert" className="text-sm leading-6 text-destructive">{error}</p>}
          {snapshot.warning && <p role="status" className="text-sm leading-6 text-amber-600 dark:text-amber-300">{snapshot.warning}</p>}
          <SystemAudioControls state={snapshot.state} busy={pending || (!ready && !active)} onAction={(action) => void handleAction(action)} />
          {snapshot.liveRecognition && snapshot.liveOriginal && (
            <div aria-live="polite" className="min-w-0 space-y-1 rounded-lg border-l-2 border-primary/40 bg-secondary/50 p-4">
              <p className="text-xs font-medium text-muted-foreground">{t('systemAudio.liveOriginalLabel')}</p>
              <p className="whitespace-pre-wrap break-words text-sm leading-6">{snapshot.liveOriginal}</p>
            </div>
          )}
          {(snapshot.caption || snapshot.source) && (
            <div aria-live="polite" className="space-y-1 rounded-lg bg-secondary p-4">
              {snapshot.source && <p className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{snapshot.source}</p>}
              {snapshot.caption && <p className="whitespace-pre-wrap text-base leading-7">{snapshot.caption}</p>}
            </div>
          )}
        </CardContent>
      </Card>
      {pipelineDebugEnabled && <PipelineDebugPanel />}
      <div className="space-y-3 text-sm leading-6 text-muted-foreground">
        <p>{t('systemAudio.engineHint')} <Link to="/voice-engine" className="text-foreground underline underline-offset-4">{t('nav.voiceEngine')}</Link> / <Link to="/ai-service" className="text-foreground underline underline-offset-4">{t('nav.aiService')}</Link></p>
        <p>{t('systemAudio.sourceLanguageHint')}</p>
        <p>{t('systemAudio.mixHint')}</p>
        <p>{t('systemAudio.delayHint')}</p>
        <p>{t('systemAudio.privacyHint')}</p>
      </div>
    </div>
  )
}
