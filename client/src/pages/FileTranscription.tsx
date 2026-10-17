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
import SpeechLanguageSelect from '@/components/SpeechLanguageSelect'
import AlphaBadge from '@/components/AlphaBadge'
import { useLocale, useT } from '@/i18n/useT'
import { t as translate, type TranslationKey } from '@/i18n'
import { ConfirmDeleteModal } from '@/features/settings/ConfirmDeleteModal'
import type { SpeechInputLanguage } from '@/services/speechInputLanguage'
import {
  errorMessage,
  fileTranscriptionService,
  formatFileDuration,
  formatFilePathForDisplay,
  isRetryableExportFailure,
  type FileMediaInfo,
  type FileTranscriptionCloudProfile,
  type FileTranscriptionEngine,
  type FileTranscriptionJobOptions,
  type FilePhase,
  type FileTranscriptionSnapshot,
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

// Cloud readiness comes from the canonical describeAsrMissing verdict carried
// in the profile metadata, never from mere profile selection.
function isCloudProfileReady(profile: FileTranscriptionCloudProfile | null | undefined): boolean {
  return profile !== null && profile !== undefined && profile.missing === ''
}

// Cancellation stays possible exactly while the backend worker can still stop early;
// the final export runs to completion once it starts, so the action closes with it.
function isCancellablePhase(phase: FilePhase): boolean {
  return phase === 'checking' || phase === 'preparing' || phase === 'loading' || phase === 'transcribing'
}

export default function FileTranscription() {
  const t = useT()
  const locale = useLocale()
  const snapshot = useSyncExternalStore(
    fileTranscriptionService.subscribe,
    fileTranscriptionService.getSnapshot,
    fileTranscriptionService.getSnapshot,
  )
  const initializationError = useSyncExternalStore(
    fileTranscriptionService.subscribe,
    fileTranscriptionService.getInitializationError,
    fileTranscriptionService.getInitializationError,
  )
  const [filePath, setFilePath] = useState('')
  const [mediaInfo, setMediaInfo] = useState<FileMediaInfo | null>(null)
  const [audioStreamIndex, setAudioStreamIndex] = useState<number | null>(null)
  const [outputDirectory, setOutputDirectory] = useState('')
  const [ffmpegDirectory, setFfmpegDirectory] = useState<string | null>(null)
  const [jobOptions, setJobOptions] = useState<FileTranscriptionJobOptions | null>(null)
  const [engine, setEngine] = useState<FileTranscriptionEngine>('local')
  const [modelId, setModelId] = useState('')
  const [language, setLanguage] = useState<SpeechInputLanguage>('auto')
  const [cloudProfileId, setCloudProfileId] = useState('')
  const [ffmpegSuggestion, setFfmpegSuggestion] = useState<string | null>(null)
  const [inspecting, setInspecting] = useState(false)
  const [actionBusy, setActionBusy] = useState(false)
  const [error, setError] = useState('')
  // This flow-scoped flag is set only for classified FFmpeg-tools failures, not any page error.
  const [ffmpegInspectFailed, setFfmpegInspectFailed] = useState(false)
  const [settingsError, setSettingsError] = useState('')
  const [copied, setCopied] = useState(false)
  const [cancelRequested, setCancelRequested] = useState(false)
  const [showCancelConfirmation, setShowCancelConfirmation] = useState(false)
  const jobOptionsLoaded = useRef(false)
  const jobOptionsRequest = useRef(0)
  const [retryingJobOptions, setRetryingJobOptions] = useState(false)
  const inspectionRequest = useRef(0)
  const ffmpegDirectoryRef = useRef<string | null>(null)
  const ffmpegDetectionStarted = useRef(false)
  const copyResetTimer = useRef<number | null>(null)

  const applyJobOptions = (value: FileTranscriptionJobOptions) => {
    const firstLoad = !jobOptionsLoaded.current
    jobOptionsLoaded.current = true
    setSettingsError('')
    setJobOptions(value)
    setEngine((current) => (firstLoad ? value.engine : current))
    setLanguage((current) => (firstLoad ? value.language : current))
    setModelId((current) =>
      firstLoad || !value.models.some((model) => model.id === current) ? value.modelId : current,
    )
    setCloudProfileId((current) =>
      firstLoad || !value.cloudProfiles.some((profile) => profile.id === current) ? value.cloudProfileId : current,
    )
  }

  useEffect(() => {
    let cancelled = false
    const generation = ++jobOptionsRequest.current
    void fileTranscriptionService.init().catch((reason) => {
      if (!cancelled) setError(`${t('files.restoreFailed')}: ${errorMessage(reason)}`)
    })
    void fileTranscriptionService
      .loadJobOptions()
      .then((value) => {
        if (cancelled || generation !== jobOptionsRequest.current) return
        applyJobOptions(value)
      })
      .catch((reason) => {
        if (!cancelled && generation === jobOptionsRequest.current) {
          setSettingsError(`${t('files.settingsFailed')}: ${errorMessage(reason)}`)
        }
      })
    return () => {
      cancelled = true
    }
  }, [locale, t])

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
        // FFmpeg detection is optional; manual folder selection remains an explicit override.
      })
    return () => { cancelled = true }
  }, [ffmpegDirectory])

  useEffect(() => () => {
    if (copyResetTimer.current !== null) window.clearTimeout(copyResetTimer.current)
  }, [])

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
    setFfmpegInspectFailed(false)
    try {
      const inspected = await fileTranscriptionService.inspect(nextFilePath, nextFfmpegDirectory)
      if (requestId !== inspectionRequest.current || !inspected) return
      setMediaInfo(inspected)
      const defaultTrack = inspected.audioTracks.find((track) => track.isDefault) ?? inspected.audioTracks[0]
      setAudioStreamIndex(defaultTrack?.index ?? null)
    } catch (reason) {
      if (requestId === inspectionRequest.current) {
        const inspectionKind = (reason as { inspectionKind?: string } | null)?.inspectionKind
        setFfmpegInspectFailed(inspectionKind === 'ffmpeg-tools')
        setError(`${t('files.inspectFailed')}: ${errorMessage(reason)}`)
      }
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
      setError(`${t('files.chooseFileFailed')}: ${errorMessage(reason)}`)
    }
  }

  const chooseOutputDirectory = async () => {
    setError('')
    try {
      const selected = await open({ directory: true, multiple: false })
      if (typeof selected === 'string' && selected) setOutputDirectory(selected)
    } catch (reason) {
      setError(`${t('files.chooseOutputFailed')}: ${errorMessage(reason)}`)
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
      setError(`${t('files.chooseFfmpegFailed')}: ${errorMessage(reason)}`)
    }
  }

  const useDetectedFfmpegDirectory = async () => {
    const suggestedDirectory = ffmpegSuggestion
    if (!suggestedDirectory || ffmpegDirectoryRef.current) return
    setSelectedFfmpegDirectory(suggestedDirectory)
    setFfmpegSuggestion(null)
    if (filePath) await inspectSelectedFile(filePath, suggestedDirectory)
  }

  const rememberSelection = async (
    patch: Partial<Pick<FileTranscriptionJobOptions, 'engine' | 'modelId' | 'language' | 'cloudProfileId'>>,
  ) => {
    try {
      await fileTranscriptionService.rememberJobSelection(patch)
    } catch (reason) {
      setError(`${t('files.rememberFailed')}: ${errorMessage(reason)}`)
    }
  }

  const startTranscription = async () => {
    if (!filePath || !outputDirectory || !mediaInfo || actionBusy) return
    const selectedCloudProfile = jobOptions?.cloudProfiles.find((profile) => profile.id === cloudProfileId)
    if (engine === 'cloud' && !isCloudProfileReady(selectedCloudProfile)) return
    setActionBusy(true)
    setError('')
    try {
      await fileTranscriptionService.startWithCurrentSettings({
        filePath,
        outputDirectory,
        ffmpegDirectory,
        audioStreamIndex,
        engine,
        modelId,
        language,
        cloudProfileId,
      })
    } catch (reason) {
      setError(`${t('files.startFailed')}: ${errorMessage(reason)}`)
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
      setError(`${t('files.cancelFailed')}: ${errorMessage(reason)}`)
    } finally {
      setActionBusy(false)
    }
  }

  const retryRestore = async () => {
    setError('')
    try {
      await fileTranscriptionService.init()
    } catch (reason) {
      setError(`${t('files.restoreFailed')}: ${errorMessage(reason)}`)
    }
  }

  const retryJobOptions = async () => {
    if (retryingJobOptions) return
    const generation = ++jobOptionsRequest.current
    setRetryingJobOptions(true)
    try {
      const value = await fileTranscriptionService.loadJobOptions()
      if (generation === jobOptionsRequest.current) applyJobOptions(value)
    } catch (reason) {
      if (generation === jobOptionsRequest.current) {
        setSettingsError(`${t('files.settingsFailed')}: ${errorMessage(reason)}`)
      }
    } finally {
      setRetryingJobOptions(false)
    }
  }

  const retryExport = async () => {
    if (!snapshot) return
    setActionBusy(true)
    setError('')
    try {
      await fileTranscriptionService.retryExport(snapshot.jobId)
    } catch (reason) {
      setError(`${t('files.retryExportFailed')}: ${errorMessage(reason)}`)
    } finally {
      setActionBusy(false)
    }
  }

  const copyText = async () => {
    if (!snapshot?.text) return
    try {
      await fileTranscriptionService.copyText(snapshot.text)
      setCopied(true)
      if (copyResetTimer.current !== null) window.clearTimeout(copyResetTimer.current)
      copyResetTimer.current = window.setTimeout(() => {
        copyResetTimer.current = null
        setCopied(false)
      }, 1400)
    } catch (reason) {
      setError(`${t('files.copyFailed')}: ${errorMessage(reason)}`)
    }
  }

  const openResultFolder = async () => {
    const resultPath = snapshot?.txtPath || snapshot?.markdownPath || snapshot?.draftPath
    if (!resultPath) return
    try {
      await shellOpen(outputDirectory || parentDirectory(resultPath))
    } catch (reason) {
      setError(`${t('files.openFolderFailed')}: ${errorMessage(reason)}`)
    }
  }

  const active = isActiveSnapshot(snapshot)
  const models = jobOptions?.models ?? []
  const cloudProfiles = jobOptions?.cloudProfiles ?? []
  const selectedCloudProfile = cloudProfiles.find((profile) => profile.id === cloudProfileId) ?? null
  const engineReady =
    engine === 'local'
      ? jobOptions !== null && jobOptions.modelsError === '' && modelId !== ''
      : isCloudProfileReady(selectedCloudProfile)
  const canStart = Boolean(
    filePath && outputDirectory && mediaInfo && engineReady && !inspecting && !actionBusy && !active,
  )
  const hasMultipleTracks = Boolean(mediaInfo && mediaInfo.audioTracks.length > 1)
  const snapshotError = snapshot?.error ?? null
  // A failed worker start reports the same native text through the start rejection and
  // the terminal snapshot. Native errors are shown as they come, so keep the snapshot
  // copy and drop the duplicated page banner instead of translating either of them.
  const pageError = error !== '' && !(snapshotError && error.endsWith(snapshotError)) ? error : ''
  const restoreError = initializationError === null ? null : `${t('files.restoreFailed')}: ${initializationError}`
  // The mount failure already shows this exact text through pageError; the
  // dedicated alert covers failures that would otherwise stay invisible.
  const showRestoreError = restoreError !== null && restoreError !== pageError

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <FileAudio className="h-5 w-5" aria-hidden />
          </div>
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
              {t('files.title')}
              <AlphaBadge className="text-xs" />
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">{t('files.description')}</p>
          </div>
        </div>
      </header>

      {pageError && <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive" role="alert"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span className="flex-1">{pageError}</span>{initializationError !== null && !showRestoreError && <Button type="button" variant="ghost" size="sm" onClick={() => void retryRestore()}>{t('files.retryRestore')}</Button>}</div>}
      {showRestoreError && <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive" role="alert"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span className="flex-1">{restoreError}</span><Button type="button" variant="ghost" size="sm" onClick={() => void retryRestore()}>{t('files.retryRestore')}</Button></div>}
      {snapshotError && <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive" role="alert"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />{snapshotError}</div>}
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
              <div className="space-y-2"><div className="flex items-center justify-between gap-3"><div><div className="text-sm font-medium">{t('files.ffmpegTitle')}</div><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t('files.ffmpegHelp')}</p></div><div className="flex shrink-0 gap-2"><Button type="button" variant="outline" size="sm" onClick={() => void chooseFfmpegDirectory()} disabled={active}>{t('files.chooseFfmpeg')}</Button>{ffmpegDirectory && <Button type="button" variant="ghost" size="sm" onClick={() => { setSelectedFfmpegDirectory(null); if (filePath) void inspectSelectedFile(filePath, null) }} disabled={active}>{t('files.useBundledFfmpeg')}</Button>}</div></div><div className="text-xs text-muted-foreground">{ffmpegDirectory ? formatFilePathForDisplay(ffmpegDirectory) : t('files.ffmpegPath')}</div></div>
              {ffmpegInspectFailed && ffmpegSuggestion && !ffmpegDirectory && <div className="flex flex-col gap-3 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between" role="status"><div className="min-w-0"><div className="text-sm font-medium">{t('files.ffmpegSuggestionTitle')}</div><p className="mt-1 text-xs text-muted-foreground">{t('files.ffmpegSuggestionBody')}</p><code className="mt-1 block break-all text-xs text-foreground">{ffmpegSuggestion}</code></div><div className="flex shrink-0 gap-2"><Button type="button" size="sm" onClick={() => void useDetectedFfmpegDirectory()} disabled={active}>{t('files.useDetectedFfmpeg')}</Button><Button type="button" variant="ghost" size="sm" onClick={() => setFfmpegSuggestion(null)} disabled={active}>{t('files.dismissFfmpegSuggestion')}</Button></div></div>}
              <Button type="button" className="w-full gap-2" onClick={() => void startTranscription()} disabled={!canStart}><Play className="h-4 w-4" />{t('files.start')}</Button>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-5">
           <Card>
             <CardHeader className="pb-4"><div className="flex items-center justify-between gap-3"><CardTitle className="text-lg">{t('files.engineTitle')}</CardTitle><Settings2 className="h-4 w-4 text-muted-foreground" /></div></CardHeader>
             <CardContent className="space-y-3 text-sm">
               <div className="flex rounded-lg bg-muted/40 p-1" role="group" aria-label={t('files.engineTitle')}>
                <Button
                  type="button"
                  variant={engine === 'local' ? 'secondary' : 'ghost'}
                  className="h-8 flex-1"
                  aria-pressed={engine === 'local'}
                  onClick={() => {
                    setEngine('local')
                    void rememberSelection({ engine: 'local' })
                  }}
                  disabled={jobOptions === null || active || actionBusy}
                >
                  {t('files.engineLocal')}
                </Button>
                <Button
                  type="button"
                  variant={engine === 'cloud' ? 'secondary' : 'ghost'}
                  className="h-8 flex-1"
                  aria-pressed={engine === 'cloud'}
                  onClick={() => {
                    setEngine('cloud')
                    void rememberSelection({ engine: 'cloud' })
                  }}
                  disabled={jobOptions === null || active || actionBusy}
                >
                  {t('files.engineCloud')}
                </Button>
              </div>
              <div className="space-y-1.5">
                <span id="file-language-label" className="text-xs font-medium text-foreground">
                  {t('files.language')}
                </span>
                <SpeechLanguageSelect
                  value={language}
                  onChange={(value) => {
                    setLanguage(value)
                    void rememberSelection({ language: value })
                  }}
                  labelledBy="file-language-label"
                  disabled={jobOptions === null || active || actionBusy}
                />
              </div>
              {engine === 'local' ? (
                jobOptions === null && settingsError === '' ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('files.settingsLoading')}
                  </div>
                ) : settingsError ? (
                  <div className="space-y-2">
                    <div className="flex items-start gap-2 text-sm text-destructive">
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span className="flex-1">{settingsError}</span>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8"
                      onClick={() => void retryJobOptions()}
                      disabled={retryingJobOptions}
                    >
                      {t('common.retry')}
                    </Button>
                  </div>
                ) : jobOptions?.modelsError ? (
                  <div className="space-y-2">
                    <div className="flex items-start gap-2 text-sm text-destructive">
                      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span className="flex-1">
                        {t('files.settingsFailed')}: {jobOptions.modelsError}
                      </span>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8"
                      onClick={() => void retryJobOptions()}
                      disabled={retryingJobOptions}
                    >
                      {t('common.retry')}
                    </Button>
                  </div>
                ) : models.length === 0 ? (
                  <div className="space-y-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-xs text-warning-strong">
                    <div>{t('files.noInstalledModels')}</div>
                    <Link
                      className="inline-flex items-center gap-1 font-medium underline underline-offset-2"
                      to="/voice-engine"
                    >
                      {t('files.openVoiceEngine')}
                      <ExternalLink className="h-3 w-3" />
                    </Link>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <span id="file-model-label" className="text-xs font-medium text-foreground">
                      {t('files.model')}
                    </span>
                    <Select
                      labelledBy="file-model-label"
                      value={modelId}
                      onChange={(value) => {
                        setModelId(value)
                        void rememberSelection({ modelId: value })
                      }}
                      disabled={active || actionBusy}
                      options={models.map((model) => ({ value: model.id, label: model.name, title: model.name }))}
                    />
                  </div>
                )
              ) : jobOptions === null && settingsError === '' ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('files.cloudProfilesLoading')}
                </div>
              ) : settingsError ? (
                <div className="space-y-2">
                  <div className="flex items-start gap-2 text-sm text-destructive">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span className="flex-1">{settingsError}</span>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8"
                    onClick={() => void retryJobOptions()}
                    disabled={retryingJobOptions}
                  >
                    {t('common.retry')}
                  </Button>
                </div>
              ) : jobOptions?.cloudProfilesError ? (
                <div className="space-y-2">
                  <div className="flex items-start gap-2 text-sm text-destructive">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span className="flex-1">
                      {t('files.cloudProfilesFailed')}: {jobOptions.cloudProfilesError}
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8"
                    onClick={() => void retryJobOptions()}
                    disabled={retryingJobOptions}
                  >
                    {t('common.retry')}
                  </Button>
                  <Link
                    className="inline-flex items-center gap-1 font-medium underline underline-offset-2"
                    to="/voice-engine"
                  >
                    {t('files.openCloudSettings')}
                    <ExternalLink className="h-3 w-3" />
                  </Link>
                </div>
              ) : cloudProfiles.length === 0 ? (
                <div className="space-y-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-xs text-warning-strong">
                  <div>{t('files.cloudNoProfiles')}</div>
                  <Link
                    className="inline-flex items-center gap-1 font-medium underline underline-offset-2"
                    to="/voice-engine"
                  >
                    {t('files.openCloudSettings')}
                    <ExternalLink className="h-3 w-3" />
                  </Link>
                </div>
              ) : (
                <>
                  <div className="space-y-1.5">
                    <span id="file-cloud-profile-label" className="text-xs font-medium text-foreground">
                      {t('files.cloudProfile')}
                    </span>
                    <Select
                      labelledBy="file-cloud-profile-label"
                      value={cloudProfileId}
                      onChange={(value) => {
                        setCloudProfileId(value)
                        void rememberSelection({ cloudProfileId: value })
                      }}
                      placeholder={t('files.cloudSelectProfile')}
                      disabled={active || actionBusy}
                      options={cloudProfiles.map((profile) => ({
                        value: profile.id,
                        label: `${profile.label} · ${profile.model}`,
                        title: `${profile.label} · ${profile.model}`,
                      }))}
                    />
                  </div>
                  {selectedCloudProfile && (
                    <div className="space-y-2 rounded-lg bg-muted/30 px-3 py-2.5">
                      <div className="flex items-start justify-between gap-4">
                        <span className="text-muted-foreground">{t('files.cloudProvider')}</span>
                        <span className="text-right font-medium">{selectedCloudProfile.label}</span>
                      </div>
                      <div className="flex items-start justify-between gap-4">
                        <span className="text-muted-foreground">{t('files.model')}</span>
                        <span className="text-right font-medium">{selectedCloudProfile.model}</span>
                      </div>
                    </div>
                  )}
                  {selectedCloudProfile && !isCloudProfileReady(selectedCloudProfile) && (
                    <div className="space-y-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5 text-xs text-warning-strong">
                      <div>
                        {t('files.cloudProfileMissing')}: {selectedCloudProfile.missing}
                      </div>
                      <Link
                        className="inline-flex items-center gap-1 font-medium underline underline-offset-2"
                        to="/voice-engine"
                      >
                        {t('files.openCloudSettings')}
                        <ExternalLink className="h-3 w-3" />
                      </Link>
                    </div>
                  )}
                </>
              )}
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
