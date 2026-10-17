import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ArrowRight, Captions, ChevronDown, Lock, Pause, Play, Square, RefreshCw, Stethoscope, type LucideIcon } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import SpeechLanguageSelect, { LANGUAGE_LABELS } from '@/components/SpeechLanguageSelect'
import { Select, type SelectOption } from '@/components/ui/select'
import { getLocale } from '@/i18n'
import { promptPresetDisplayName } from '@/i18n/displayNames'
import { useLocale, useT } from '@/i18n/useT'
import { getPromptPresets, getSetting, setSetting, TRANSLATION_PRESET_PREFIX, type PromptPreset } from '@/services/store'
import { getWorkMode } from '@/services/transcription'
import { loadActiveAsrProfile } from '@/features/settings/asrProfileStore'
import { addRuntimeEvent } from '@/services/debugLog'
import { isLiveRecognitionProvider } from '@/lib/asrModels'
import { isSpeechInputLanguage, type SpeechInputLanguage } from '@/services/speechInputLanguage'
import { getSystemAudioDualSubtitles, getSystemAudioMaxSegmentSeconds, getSystemAudioSourceLanguage, listSystemAudioDevices, systemAudioSession, type SubtitleTargetLanguage, type SystemAudioDevice, type SystemAudioState } from '@/services/systemAudio'
import { DEFAULT_SEGMENT_SECONDS, MAX_SEGMENT_SECONDS, MIN_SEGMENT_SECONDS, SEGMENT_SECONDS_STEP } from '@/services/subtitleSegmentation'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { setPipelineDebugEnabled } from '@/services/pipelineTrace'
import PipelineDebugPanel from '@/features/systemAudio/PipelineDebugPanel'
import SessionStatusDot from '@/features/systemAudio/SessionStatusDot'
import SettingsRow from '@/features/systemAudio/SettingsRow'
import SubtitleSavingSettings from '@/features/systemAudio/SubtitleSavingSettings'
import SystemAudioHelpContent from '@/features/systemAudio/SystemAudioHelpContent'
import { PageHelp } from '@/features/settings/PageHelp'
import AlphaBadge from '@/components/AlphaBadge'

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
          {/* The short visible label keeps the session row on one line; the full action, which also
              returns the app to dictation, stays in the accessible name and the hover hint. */}
          <Button variant="outline" disabled={state === 'stopping'} onClick={() => onAction('stop')} aria-label={t('systemAudio.stop')} title={t('systemAudio.stop')}><Square className="mr-2 h-4 w-4" />{t('systemAudio.stopShort')}</Button>
        </>
      )}
    </div>
  )
}

// The content stays mounted and is hidden rather than unmounted, so the controls inside keep their
// state and a collapsed row never changes what the page has loaded.
function CollapsibleRow({ id, icon: Icon, title, description, open, onToggle, children }: { id: string; icon: LucideIcon; title: string; description: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
        className="flex w-full items-center gap-4 px-6 py-3.5 text-left transition-colors hover:bg-accent"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{title}</span>
          <span className="block truncate text-xs text-muted-foreground">{description}</span>
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      <div id={id} hidden={!open} className="px-6 pb-4 pl-[4.5rem]">{children}</div>
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
  const [liveRecognitionEnabled, setLiveRecognitionEnabled] = useState(false)
  const [liveRecognitionReady, setLiveRecognitionReady] = useState(false)
  const [liveRecognitionError, setLiveRecognitionError] = useState('')
  const [activeAsrProvider, setActiveAsrProvider] = useState('')
  const [captionsOpen, setCaptionsOpen] = useState(false)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const locale = useLocale()
  // Derive option labels from the loaded presets on every locale change; they are not stored in state.
  const translationOptions = useMemo(() => buildTranslationOptions(presets), [presets, locale])
  const active = snapshot.state !== 'idle'
  const error = snapshot.error || loadError || liveRecognitionError
  const mode = getWorkMode()
  // Mirrors the runtime gate: live recognition is implemented only by CloudAPIProvider, and only
  // the Deepgram profile can open it; every other engine keeps batch recognition, so the page must
  // not offer the setting at all.
  const liveRecognitionSupported = mode === 'cloud_api' && isLiveRecognitionProvider(activeAsrProvider)
  // One-line state shown on the captions row, kept in step with what will actually run: recognition-only
  // mode ignores translation and dual subtitles, and live recognition counts only where it is offered.
  // Empty until the saved values have loaded, so a row never advertises a default that the stored
  // setting is about to replace.
  const captionsSummary = ready
    ? [
      t('systemAudio.summaryMaxLength', { duration: t('duration.seconds', { count: maxSegmentSeconds }) }),
      asrOnlyTest ? t('systemAudio.summaryRecognitionOnly') : dualSubtitles ? t('systemAudio.summaryDual') : t('systemAudio.summaryTranslationOnly'),
      liveRecognitionSupported && liveRecognitionEnabled ? t('systemAudio.summaryLive') : '',
    ].filter(Boolean).join(' · ')
    : ''
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
      // Recognition-only mode disables the translation controls above, so a saved "on" must stay
      // visible instead of hiding behind a collapsed row.
      if (debugPipeline || asrOnly) setDiagnosticsOpen(true)
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

  // Read-only summary of what the running session was started with; the page selects are locked meanwhile.
  const deviceLabel = deviceOptions.find((option) => option.value === deviceId)?.label ?? ''
  const sourceLanguageLabel = t(LANGUAGE_LABELS[sourceLanguage])
  // The presets read "Translate to X"; the summary names just the language, falling back to the preset
  // name for a target the speech-language list does not cover.
  const targetLanguageLabel = asrOnlyTest
    ? t('systemAudio.summaryRecognitionOnly')
    : isSpeechInputLanguage(targetLanguage)
      ? t(LANGUAGE_LABELS[targetLanguage])
      : translationOptions.find((option) => option.value === targetLanguage)?.label ?? ''

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="mb-2 flex items-center gap-2 text-2xl font-bold">
            {t('systemAudio.title')}
            <AlphaBadge className="text-xs" />
          </h1>
          <p className="text-sm text-muted-foreground">{t('systemAudio.description')}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="rounded-md bg-secondary px-2 py-1 text-xs text-muted-foreground">{t(mode === 'local' ? 'mode.local' : mode === 'cloud_api' ? 'mode.cloudApi' : 'mode.server')}</span>
          <PageHelp title={t('help.systemAudio.title')}>
            <SystemAudioHelpContent />
          </PageHelp>
        </div>
      </header>
      <Card>
        <CardContent className="p-0">
          {active ? (
            <div className="space-y-3 p-5">
              <div className="flex flex-wrap items-center gap-3">
                <SessionStatusDot state={snapshot.state} className="h-2.5 w-2.5" />
                <p role="status" className="text-sm font-semibold">{t(`systemAudio.status.${snapshot.state}`)}</p>
                <div className="ml-auto">
                  <SystemAudioControls state={snapshot.state} busy={pending || (!ready && !active)} onAction={(action) => void handleAction(action)} />
                </div>
              </div>
              {/* Indented to the status text: the dot (h-2.5) plus the row gap (gap-3). */}
              <p className="flex min-w-0 items-center gap-1.5 pl-[1.375rem] text-xs text-muted-foreground">
                {/* Returning to the page mid-session remounts it; until the saved values load, the
                    summary would name defaults the stored settings are about to replace. */}
                {ready && (
                  <>
                    <span className="truncate">{deviceLabel}</span>
                    <span aria-hidden>·</span>
                    <span className="shrink-0">{sourceLanguageLabel}</span>
                    <ArrowRight className="h-3 w-3 shrink-0" aria-hidden />
                    <span className="shrink-0">{targetLanguageLabel}</span>
                  </>
                )}
                <span className="inline-flex shrink-0" title={t('systemAudio.lockedDuringSession')}>
                  <Lock className="h-3 w-3" aria-hidden />
                  <span className="sr-only">{t('systemAudio.lockedDuringSession')}</span>
                </span>
              </p>
            </div>
          ) : (
            <div className="flex flex-wrap items-end gap-3 p-5">
              <div className="min-w-0 flex-[1.5_1_240px] space-y-2">
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
              <div className="min-w-0 flex-[1_1_150px] space-y-2">
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
              <div className="flex h-9 items-center text-muted-foreground" aria-hidden>
                <ArrowRight className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-[1.2_1_180px] space-y-2">
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
              <SystemAudioControls state={snapshot.state} busy={pending || (!ready && !active)} onAction={(action) => void handleAction(action)} />
            </div>
          )}
          {(error || snapshot.warning) && (
            <div className="space-y-1 border-t border-border px-5 py-3">
              {error && <p role="alert" className="text-sm leading-6 text-destructive">{error}</p>}
              {snapshot.warning && <p role="status" className="text-sm leading-6 text-amber-600 dark:text-amber-300">{snapshot.warning}</p>}
            </div>
          )}
          {((snapshot.liveRecognition && snapshot.liveOriginal) || snapshot.caption || snapshot.source) && (
            <div className="space-y-3 border-t border-border p-5">
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
            </div>
          )}
          {!active && (
            <div className="flex flex-wrap items-center gap-2.5 border-t border-border px-5 py-3 text-xs text-muted-foreground">
              <SessionStatusDot state={snapshot.state} />
              <p role="status" className="font-medium text-foreground">{t(`systemAudio.status.${snapshot.state}`)}</p>
              <span aria-hidden>·</span>
              <span>{t('systemAudio.dictationBlockedHint')}</span>
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-0">
          <h2 className="px-6 pb-2 pt-4 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t('systemAudio.settingsHeading')}</h2>
          <div className="divide-y divide-border border-t border-border">
            <SettingsRow
              icon={Captions}
              title={t('systemAudio.captionsRow')}
              summary={captionsSummary}
              configureLabel={t('systemAudio.configureCaptions')}
              locked={active}
              onConfigure={() => setCaptionsOpen(true)}
            />
            <SubtitleSavingSettings active={active} pending={pending} onPendingChange={setPending} />
            <CollapsibleRow
              id="subtitle-diagnostics"
              icon={Stethoscope}
              title={t('systemAudio.diagnostics')}
              description={t('systemAudio.diagnosticsDesc')}
              open={diagnosticsOpen}
              onToggle={() => setDiagnosticsOpen(!diagnosticsOpen)}
            >
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
            </CollapsibleRow>
          </div>
        </CardContent>
      </Card>
      {pipelineDebugEnabled && <PipelineDebugPanel />}
      {/* The dialog sits last so the page-level alert stays the first one in the document. */}
      {captionsOpen && (
        <Modal title={t('systemAudio.captionsRow')} onClose={() => setCaptionsOpen(false)} showCloseButton panelClassName="custom-scrollbar w-[520px]">
          <div className="mt-4 space-y-6">
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
            {/* The page-level alert is behind the dimmed backdrop and hidden from assistive technology while a dialog is open. */}
            {liveRecognitionError && <p role="alert" className="text-sm leading-6 text-destructive">{liveRecognitionError}</p>}
          </div>
        </Modal>
      )}
    </div>
  )
}
