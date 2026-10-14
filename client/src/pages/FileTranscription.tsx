import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Link } from 'react-router-dom'
import { open } from '@tauri-apps/plugin-dialog'
import { open as shellOpen } from '@tauri-apps/plugin-shell'
import {
  AlertCircle,
  CheckCircle2,
  Clipboard,
  ExternalLink,
  FileAudio,
  FolderOpen,
  Info,
  Loader2,
  Play,
  RotateCcw,
  Settings2,
  Square,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Select } from '@/components/ui/select'
import { useT } from '@/i18n/useT'
import { t as translate, type TranslationKey } from '@/i18n'
import { ConfirmDeleteModal } from '@/features/settings/ConfirmDeleteModal'
import { getSpeechLanguageEnglishName, type SpeechInputLanguage } from '@/services/speechInputLanguage'
import {
  fileTranscriptionService,
  formatFileDuration,
  formatFilePathForDisplay,
  isRetryableExportFailure,
  type FileMediaInfo,
  type FileTranscriptionCloudProfile,
  type FileTranscriptionEngine,
  type FilePhase,
  type FileTranscriptionSnapshot,
  type LocalFileSettings,
} from '@/services/fileTranscription'

function phaseLabel(phase: FilePhase): string {
  const labels: Record<FilePhase, TranslationKey> = {
    checking: 'files.phaseChecking',
    preparing: 'files.phasePreparing',
    loading: 'files.phaseLoading',
    transcribing: 'files.phaseTranscribing',
    finalizing: 'files.phaseFinalizing',
    cancelling: 'files.phaseCancelling',
    completed: 'files.phaseCompleted',
    no_speech: 'files.phaseNoSpeech',
    cancelled: 'files.phaseCancelled',
    failed: 'files.phaseFailed',
  }
  return translate(labels[phase])
}

function languageLabel(language: SpeechInputLanguage): string {
  const name = getSpeechLanguageEnglishName(language)
  if (name === 'Russian') return translate('local.lang.ru')
  if (name === 'Ukrainian') return translate('local.lang.uk')
  if (name === 'English') return translate('local.lang.en')
  if (name === 'Chinese') return translate('local.lang.zh')
  return translate('common.auto')
}

function acceleratorLabel(accelerator: string): string {
  if (accelerator === 'cpu') return 'CPU'
  if (accelerator === 'gpu') return 'GPU'
  return translate('common.auto')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parentDirectory(path: string): string {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (separator === 2 && path[1] === ':') return path.slice(0, 3)
  return separator > 0 ? path.slice(0, separator) : path
}

function statusTone(snapshot: FileTranscriptionSnapshot | null): string {
  if (!snapshot) return 'border-border bg-muted/30 text-muted-foreground'
  if (snapshot.phase === 'completed') return 'border-success/30 bg-success/10 text-success-strong'
  if (snapshot.phase === 'failed' || snapshot.phase === 'no_speech') return 'border-destructive/30 bg-destructive/10 text-destructive'
  if (snapshot.phase === 'cancelled') return 'border-warning/30 bg-warning/10 text-warning-strong'
  return 'border-primary/20 bg-primary/5 text-primary'
}

function isActiveSnapshot(snapshot: FileTranscriptionSnapshot | null): boolean {
  return Boolean(snapshot && !snapshot.resourcesReleased)
}

// Cancellation stays possible exactly while the backend worker can still stop early;
// the final export runs to completion once it starts, so the action closes with it.
function isCancellablePhase(phase: FilePhase): boolean {
  return phase === 'checking' || phase === 'preparing' || phase === 'loading' || phase === 'transcribing'
}

export default function FileTranscription() {
  const t = useT()
  const snapshot = useSyncExternalStore(
    fileTranscriptionService.subscribe,
    fileTranscriptionService.getSnapshot,
    fileTranscriptionService.getSnapshot,
  )
  const [filePath, setFilePath] = useState('')
  const [mediaInfo, setMediaInfo] = useState<FileMediaInfo | null>(null)
  const [audioStreamIndex, setAudioStreamIndex] = useState<number | null>(null)
  const [outputDirectory, setOutputDirectory] = useState('')
  const [ffmpegDirectory, setFfmpegDirectory] = useState<string | null>(null)
  const [localSettings, setLocalSettings] = useState<LocalFileSettings | null>(null)
  const [engine, setEngine] = useState<FileTranscriptionEngine>('local')
  const [cloudProfiles, setCloudProfiles] = useState<FileTranscriptionCloudProfile[]>([])
  const [cloudProfileId, setCloudProfileId] = useState('')
  const [cloudProfilesLoading, setCloudProfilesLoading] = useState(true)
  const [cloudProfilesError, setCloudProfilesError] = useState('')
  const [ffmpegSuggestion, setFfmpegSuggestion] = useState<string | null>(null)
  const [inspecting, setInspecting] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [error, setError] = useState('')
  const [settingsError, setSettingsError] = useState('')
  const [copied, setCopied] = useState(false)
  const [cancelRequested, setCancelRequested] = useState(false)
  const [showCancelConfirmation, setShowCancelConfirmation] = useState(false)
  const inspectionRequest = useRef(0)
  const ffmpegDirectoryRef = useRef<string | null>(null)
  const ffmpegDetectionStarted = useRef(false)

  useEffect(() => {
    void fileTranscriptionService.init().catch((reason) => setError(`${t('files.restoreFailed')}: ${errorText(reason)}`))
    void fileTranscriptionService.getLocalSettings()
      .then((value) => { setSettingsError(''); setLocalSettings(value) })
      .catch((reason) => setSettingsError(`${t('files.settingsFailed')}: ${errorText(reason)}`))
  }, [t])

  useEffect(() => {
    let cancelled = false
    setCloudProfilesLoading(true)
    setCloudProfilesError('')
    void fileTranscriptionService.getCloudProfiles()
      .then(({ profiles, activeId }) => {
        if (cancelled) return
        setCloudProfiles(profiles)
        setCloudProfileId((current) => {
          if (profiles.some((profile) => profile.id === current)) return current
          if (profiles.some((profile) => profile.id === activeId)) return activeId
          return profiles[0]?.id ?? ''
        })
      })
      .catch((reason) => {
        if (!cancelled) setCloudProfilesError(errorText(reason))
      })
      .finally(() => {
        if (!cancelled) setCloudProfilesLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!snapshot || snapshot.resourcesReleased) setCancelRequested(false)
    if (!snapshot || !isCancellablePhase(snapshot.phase)) setShowCancelConfirmation(false)
  }, [snapshot])

  useEffect(() => {
    if (ffmpegDirectory || ffmpegDetectionStarted.current) return
    ffmpegDetectionStarted.current = true
    let cancelled = false
    void fileTranscriptionService.detectFfmpegDirectory()
      .then((candidate) => {
        if (!cancelled && !ffmpegDirectoryRef.current && candidate) setFfmpegSuggestion(candidate)
      })
      .catch(() => {
        // FFmpeg detection is optional; PATH and manual folder selection remain authoritative.
      })
    return () => { cancelled = true }
  }, [ffmpegDirectory])

  const setSelectedFfmpegDirectory = (directory: string | null) => {
    ffmpegDirectoryRef.current = directory
    setFfmpegDirectory(directory)
  }

  const inspectSelectedFile = async (nextFilePath: string, nextFfmpegDirectory: string | null) => {
    const requestId = ++inspectionRequest.current
    setInspecting(true)
    setMediaInfo(null)
    setAudioStreamIndex(null)
    setError('')
    try {
      const inspected = await fileTranscriptionService.inspect(nextFilePath, nextFfmpegDirectory)
      if (requestId !== inspectionRequest.current || !inspected) return
      setMediaInfo(inspected)
      const defaultTrack = inspected.audioTracks.find((track) => track.isDefault) ?? inspected.audioTracks[0]
      setAudioStreamIndex(defaultTrack?.index ?? null)
    } catch (reason) {
      if (requestId === inspectionRequest.current) setError(`${t('files.inspectFailed')}: ${errorText(reason)}`)
    } finally {
      if (requestId === inspectionRequest.current) setInspecting(false)
    }
  }

  const chooseFile = async () => {
    setError('')
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: t('files.mediaFilter'), extensions: ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'mp4', 'mkv', 'webm', 'mov', 'avi'] }],
      })
      if (typeof selected !== 'string' || !selected) return
      setFilePath(selected)
      await inspectSelectedFile(selected, ffmpegDirectory)
    } catch (reason) {
      setError(`${t('files.chooseFileFailed')}: ${errorText(reason)}`)
    }
  }

  const chooseOutputDirectory = async () => {
    setError('')
    try {
      const selected = await open({ directory: true, multiple: false })
      if (typeof selected === 'string' && selected) setOutputDirectory(selected)
    } catch (reason) {
      setError(`${t('files.chooseOutputFailed')}: ${errorText(reason)}`)
    }
  }

  const chooseFfmpegDirectory = async () => {
    setError('')
    try {
      const selected = await open({ directory: true, multiple: false })
      if (typeof selected !== 'string' || !selected) return
      setSelectedFfmpegDirectory(selected)
      setFfmpegSuggestion(null)
      if (filePath) await inspectSelectedFile(filePath, selected)
    } catch (reason) {
      setError(`${t('files.chooseFfmpegFailed')}: ${errorText(reason)}`)
    }
  }

  const useDetectedFfmpegDirectory = async () => {
    const suggestedDirectory = ffmpegSuggestion
    if (!suggestedDirectory || ffmpegDirectoryRef.current) return
    setSelectedFfmpegDirectory(suggestedDirectory)
    setFfmpegSuggestion(null)
    if (filePath) await inspectSelectedFile(filePath, suggestedDirectory)
  }

  const startTranscription = async () => {
    if (!filePath || !outputDirectory || !mediaInfo || actionBusy) return
    const selectedCloudProfile = cloudProfiles.find((profile) => profile.id === cloudProfileId)
    if (engine === 'cloud' && !selectedCloudProfile) return
    setActionBusy(true)
    setError('')
    try {
      await fileTranscriptionService.startWithCurrentSettings({
        filePath,
        outputDirectory,
        ffmpegDirectory,
        audioStreamIndex,
        engine,
        cloudProfileId: selectedCloudProfile ? selectedCloudProfile.id : undefined,
      })
    } catch (reason) {
      setError(`${t('files.startFailed')}: ${errorText(reason)}`)
    } finally {
      setActionBusy(false)
    }
  }

  const cancelTranscription = async () => {
    setActionBusy(true)
    setCancelRequested(true)
    setError('')
    try {
      await fileTranscriptionService.cancel()
    } catch (reason) {
      setCancelRequested(false)
      setError(`${t('files.cancelFailed')}: ${errorText(reason)}`)
    } finally {
      setActionBusy(false)
    }
  }

  const retryRestore = async () => {
    setError('')
    try {
      await fileTranscriptionService.init()
    } catch (reason) {
      setError(`${t('files.restoreFailed')}: ${errorText(reason)}`)
    }
  }

  const retryLocalSettings = async () => {
    try {
      setLocalSettings(await fileTranscriptionService.getLocalSettings())
      setSettingsError('')
    } catch (reason) {
      setSettingsError(`${t('files.settingsFailed')}: ${errorText(reason)}`)
    }
  }

  const retryExport = async () => {
    if (!snapshot) return
    setActionBusy(true)
    setError('')
    try {
      await fileTranscriptionService.retryExport(snapshot.jobId)
    } catch (reason) {
      setError(`${t('files.retryExportFailed')}: ${errorText(reason)}`)
    } finally {
      setActionBusy(false)
    }
  }

  const copyText = async () => {
    if (!snapshot?.text) return
    try {
      await fileTranscriptionService.copyText(snapshot.text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch (reason) {
      setError(`${t('files.copyFailed')}: ${errorText(reason)}`)
    }
  }

  const openResultFolder = async () => {
    const resultPath = snapshot?.txtPath || snapshot?.markdownPath || snapshot?.draftPath
    if (!resultPath) return
    try {
      await shellOpen(outputDirectory || parentDirectory(resultPath))
    } catch (reason) {
      setError(`${t('files.openFolderFailed')}: ${errorText(reason)}`)
    }
  }

  const active = isActiveSnapshot(snapshot)
  const selectedCloudProfile = cloudProfiles.find((profile) => profile.id === cloudProfileId) ?? null
  const engineReady = engine === 'local' ? Boolean(localSettings?.modelInstalled) : Boolean(selectedCloudProfile)
  const canStart = Boolean(filePath && outputDirectory && mediaInfo && engineReady && !inspecting && !actionBusy && !active)
  const hasMultipleTracks = Boolean(mediaInfo && mediaInfo.audioTracks.length > 1)

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <FileAudio className="h-5 w-5" aria-hidden />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{t('files.title')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t('files.description')}</p>
          </div>
        </div>
      </header>

      {error && <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive" role="alert"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span className="flex-1">{error}</span>{fileTranscriptionService.getInitializationError() && <Button type="button" variant="ghost" size="sm" onClick={() => void retryRestore()}>{t('files.retryRestore')}</Button>}</div>}
      {snapshot?.error && <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive" role="alert"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{snapshot.error}</div>}
      {snapshot?.warning != null && <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-sm text-warning-strong" role="status"><Info className="mt-0.5 h-4 w-4 shrink-0" />{snapshot.warning}</div>}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.45fr)_minmax(280px,0.8fr)]">
        <div className="space-y-5">
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="text-lg">{t('files.sourceTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button type="button" variant="outline" className="w-full justify-start gap-2" onClick={() => void chooseFile()} disabled={inspecting || active}>
                {inspecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileAudio className="h-4 w-4" />}
                {inspecting ? t('files.inspecting') : t('files.chooseFile')}
              </Button>
              {filePath && <div className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-sm"><div className="text-xs text-muted-foreground">{t('files.selectedFile')}</div><div className="mt-1 break-all font-medium" title={filePath}>{formatFilePathForDisplay(filePath)}</div></div>}
              {mediaInfo && <div className="grid gap-3 sm:grid-cols-2"><div className="rounded-lg bg-muted/30 px-3 py-2"><div className="text-xs text-muted-foreground">{t('files.duration')}</div><div className="mt-1 font-medium">{formatFileDuration(mediaInfo.durationMs) || t('files.unknownDuration')}</div></div><div className="rounded-lg bg-muted/30 px-3 py-2"><div className="text-xs text-muted-foreground">{t('files.audioTracks')}</div><div className="mt-1 font-medium">{mediaInfo.audioTracks.length}</div></div></div>}
              {hasMultipleTracks && mediaInfo && <div className="space-y-1.5"><span id="file-audio-track-label" className="text-xs font-medium text-foreground">{t('files.audioTrack')}</span><Select labelledBy="file-audio-track-label" value={String(audioStreamIndex ?? '')} onChange={(value) => setAudioStreamIndex(Number(value))} options={mediaInfo.audioTracks.map((track) => ({ value: String(track.index), label: track.label || `${t('files.track')} ${track.index}`, title: track.isDefault ? t('files.defaultTrack') : undefined }))} /></div>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-4"><CardTitle className="text-lg">{t('files.destinationTitle')}</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2"><div className="min-w-0 flex-1 rounded-md border border-input-border bg-input-bg px-3 py-2 text-sm text-foreground">{outputDirectory ? formatFilePathForDisplay(outputDirectory) : <span className="text-input-placeholder">{t('files.noOutputFolder')}</span>}</div><Button type="button" variant="outline" size="icon" onClick={() => void chooseOutputDirectory()} aria-label={t('files.chooseOutput')} disabled={active}><FolderOpen className="h-4 w-4" /></Button></div>
              <div className="space-y-2"><div className="flex items-center justify-between gap-3"><div><div className="text-sm font-medium">{t('files.ffmpegTitle')}</div><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t('files.ffmpegHelp')}</p></div><div className="flex shrink-0 gap-2"><Button type="button" variant="outline" size="sm" onClick={() => void chooseFfmpegDirectory()} disabled={active}>{t('files.chooseFfmpeg')}</Button>{ffmpegDirectory && <Button type="button" variant="ghost" size="sm" onClick={() => { setSelectedFfmpegDirectory(null); if (filePath) void inspectSelectedFile(filePath, null) }} disabled={active}>{t('files.usePath')}</Button>}</div></div><div className="text-xs text-muted-foreground">{ffmpegDirectory ? formatFilePathForDisplay(ffmpegDirectory) : t('files.ffmpegPath')}</div></div>
              {ffmpegSuggestion && !ffmpegDirectory && <div className="flex flex-col gap-3 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between" role="status"><div className="min-w-0"><div className="text-sm font-medium">{t('files.ffmpegSuggestionTitle')}</div><p className="mt-1 text-xs text-muted-foreground">{t('files.ffmpegSuggestionBody')}</p><code className="mt-1 block break-all text-xs text-foreground">{ffmpegSuggestion}</code></div><div className="flex shrink-0 gap-2"><Button type="button" size="sm" onClick={() => void useDetectedFfmpegDirectory()} disabled={active}>{t('files.useDetectedFfmpeg')}</Button><Button type="button" variant="ghost" size="sm" onClick={() => setFfmpegSuggestion(null)} disabled={active}>{t('files.dismissFfmpegSuggestion')}</Button></div></div>}
              <Button type="button" className="w-full gap-2" onClick={() => void startTranscription()} disabled={!canStart}><Play className="h-4 w-4" />{t('files.start')}</Button>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-5">
           <Card>
             <CardHeader className="pb-4"><div className="flex items-center justify-between gap-3"><CardTitle className="text-lg">{t('files.engineTitle')}</CardTitle><Settings2 className="h-4 w-4 text-muted-foreground" /></div></CardHeader>
             <CardContent className="space-y-3 text-sm">
               <div className="flex rounded-lg bg-muted/40 p-1" role="group" aria-label={t('files.engineTitle')}>
                 <Button type="button" variant={engine === 'local' ? 'secondary' : 'ghost'} className="h-8 flex-1" aria-pressed={engine === 'local'} onClick={() => setEngine('local')} disabled={active || actionBusy}>{t('files.engineLocal')}</Button>
                 <Button type="button" variant={engine === 'cloud' ? 'secondary' : 'ghost'} className="h-8 flex-1" aria-pressed={engine === 'cloud'} onClick={() => setEngine('cloud')} disabled={active || actionBusy}>{t('files.engineCloud')}</Button>
               </div>
               {engine === 'local' ? localSettings ? <><div className="flex items-start justify-between gap-4"><span className="text-muted-foreground">{t('files.model')}</span><span className="text-right font-medium">{localSettings.modelName}</span></div><div className="flex items-start justify-between gap-4"><span className="text-muted-foreground">{t('files.language')}</span><span className="text-right font-medium">{languageLabel(localSettings.language)}</span></div><div className="flex items-start justify-between gap-4"><span className="text-muted-foreground">{t('files.accelerator')}</span><span className="text-right font-medium">{acceleratorLabel(localSettings.accelerator)}</span></div>{!localSettings.modelInstalled && <div className="space-y-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-xs text-warning-strong"><div>{t('files.modelMissing')}</div><Link className="inline-flex items-center gap-1 font-medium underline underline-offset-2" to="/voice-engine">{t('files.openVoiceEngine')}<ExternalLink className="h-3 w-3" /></Link></div>}</> : settingsError ? <div className="space-y-2"><div className="flex items-start gap-2 text-sm text-destructive"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span className="flex-1">{settingsError}</span></div><Button type="button" variant="outline" size="sm" className="h-8" onClick={() => void retryLocalSettings()}>{t('common.retry')}</Button></div> : <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('files.settingsLoading')}</div> : cloudProfilesLoading ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t('files.cloudProfilesLoading')}</div> : cloudProfilesError ? <div className="space-y-2"><div className="flex items-start gap-2 text-sm text-destructive"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span className="flex-1">{t('files.cloudProfilesFailed')}: {cloudProfilesError}</span></div><Link className="inline-flex items-center gap-1 font-medium underline underline-offset-2" to="/voice-engine">{t('files.openCloudSettings')}<ExternalLink className="h-3 w-3" /></Link></div> : cloudProfiles.length === 0 ? <div className="space-y-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-xs text-warning-strong"><div>{t('files.cloudNoProfiles')}</div><Link className="inline-flex items-center gap-1 font-medium underline underline-offset-2" to="/voice-engine">{t('files.openCloudSettings')}<ExternalLink className="h-3 w-3" /></Link></div> : <>
                 <div className="space-y-1.5"><span id="file-cloud-profile-label" className="text-xs font-medium text-foreground">{t('files.cloudProfile')}</span><Select labelledBy="file-cloud-profile-label" value={cloudProfileId} onChange={setCloudProfileId} placeholder={t('files.cloudSelectProfile')} disabled={active || actionBusy} options={cloudProfiles.map((profile) => ({ value: profile.id, label: `${profile.label} · ${profile.model}`, title: `${profile.provider} · ${profile.model}` }))} /></div>
                 {selectedCloudProfile && <div className="space-y-2 rounded-lg bg-muted/30 px-3 py-2.5"><div className="flex items-start justify-between gap-4"><span className="text-muted-foreground">{t('files.cloudProvider')}</span><span className="text-right font-medium">{selectedCloudProfile.provider}</span></div><div className="flex items-start justify-between gap-4"><span className="text-muted-foreground">{t('files.model')}</span><span className="text-right font-medium">{selectedCloudProfile.model}</span></div><div className="flex items-start justify-between gap-4"><span className="text-muted-foreground">{t('files.cloudLabel')}</span><span className="text-right font-medium">{selectedCloudProfile.label}</span></div></div>}
               </>}
             </CardContent>
           </Card>

          {snapshot && <Card>
            <CardHeader className="pb-4"><div className="flex items-center justify-between gap-3"><CardTitle className="text-lg">{t('files.jobTitle')}</CardTitle><span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs font-medium ${statusTone(snapshot)}`}>{snapshot.phase === 'completed' ? <CheckCircle2 className="h-3.5 w-3.5" /> : snapshot.phase === 'failed' || snapshot.phase === 'no_speech' ? <AlertCircle className="h-3.5 w-3.5" /> : null}{phaseLabel(snapshot.phase)}</span></div></CardHeader>
            <CardContent className="space-y-4">
              {snapshot.phase === 'preparing' && snapshot.durationMs !== null && snapshot.durationMs > 0 && <progress className="h-2 w-full accent-primary" value={Math.min(snapshot.processedMs, snapshot.durationMs)} max={snapshot.durationMs} aria-label={t('files.processedProgress')} />}
              {snapshot.phase === 'preparing' && (snapshot.durationMs === null || snapshot.durationMs <= 0) && <progress className="h-2 w-full accent-primary" aria-label={t('files.processedProgress')} />}
              {(snapshot.phase === 'transcribing' || snapshot.phase === 'finalizing' || snapshot.phase === 'cancelling') && snapshot.durationMs !== null && snapshot.durationMs > 0 && <progress className="h-2 w-full accent-primary" value={Math.min(snapshot.savedMs, snapshot.durationMs)} max={snapshot.durationMs} aria-label={t('files.savedProgress')} />}
              {(snapshot.phase === 'transcribing' || snapshot.phase === 'finalizing' || snapshot.phase === 'cancelling') && (snapshot.durationMs === null || snapshot.durationMs <= 0) && <progress className="h-2 w-full accent-primary" aria-label={t('files.savedProgress')} />}
              {(snapshot.phase === 'preparing' || snapshot.phase === 'transcribing' || snapshot.phase === 'finalizing' || snapshot.phase === 'cancelling') && <p className="text-sm text-muted-foreground">{snapshot.phase === 'preparing' ? snapshot.durationMs !== null && snapshot.durationMs > 0 ? t('files.processedProgressText', { processed: formatFileDuration(snapshot.processedMs), duration: formatFileDuration(snapshot.durationMs) }) : t('files.processedSoFar', { processed: formatFileDuration(snapshot.processedMs) }) : snapshot.durationMs ? t('files.savedProgressText', { saved: formatFileDuration(snapshot.savedMs), duration: formatFileDuration(snapshot.durationMs) }) : t('files.savedSoFar', { saved: formatFileDuration(snapshot.savedMs) })}</p>}
              {snapshot.text && <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/20 p-3 text-sm leading-relaxed">{snapshot.text}</pre>}
              {snapshot.draftPath && snapshot.phase !== 'completed' && <div className="text-xs text-muted-foreground">{t('files.draftSaved')} <code className="break-all">{snapshot.draftPath}</code></div>}
              {snapshot.phase === 'completed' && <div className="space-y-2 text-sm text-success-strong"><div>{snapshot.txtPath && <code className="block break-all">{t('files.txtPath')}: {snapshot.txtPath}</code>}</div><div>{snapshot.markdownPath && <code className="block break-all">{t('files.markdownPath')}: {snapshot.markdownPath}</code>}</div></div>}
              <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => void openResultFolder()} disabled={!snapshot.txtPath && !snapshot.markdownPath && !snapshot.draftPath}><FolderOpen className="h-3.5 w-3.5" />{t('files.openFolder')}</Button><Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => void copyText()} disabled={!snapshot.text}>{copied ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Clipboard className="h-3.5 w-3.5" />}{copied ? t('files.copied') : t('files.copyText')}</Button>{isRetryableExportFailure(snapshot) && <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => void retryExport()} disabled={actionBusy}><RotateCcw className="h-3.5 w-3.5" />{t('files.retryExport')}</Button>}{active && isCancellablePhase(snapshot.phase) && <Button type="button" variant="destructive" size="sm" className="gap-1.5" onClick={() => setShowCancelConfirmation(true)} disabled={actionBusy || cancelRequested}><Square className="h-3.5 w-3.5" />{cancelRequested || actionBusy ? t('files.cancelling') : t('files.cancel')}</Button>}</div>
            </CardContent>
          </Card>}
        </div>
      </div>
      {showCancelConfirmation && snapshot && active && isCancellablePhase(snapshot.phase) && <ConfirmDeleteModal
        title={t('files.cancelTitle')}
        body={t('files.cancelBody')}
        confirmLabel={t('files.confirmCancel')}
        onCancel={() => setShowCancelConfirmation(false)}
        onConfirm={() => {
          setShowCancelConfirmation(false)
          void cancelTranscription()
        }}
        danger
        showCloseButton
      />}
    </div>
  )
}
