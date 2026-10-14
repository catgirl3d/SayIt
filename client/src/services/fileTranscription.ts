import * as bridge from './bridge'
import { getSetting } from './store'
import { getSpeechInputLanguage, type SpeechInputLanguage } from './speechInputLanguage'
import { localModelDisplayName } from '@/i18n/displayNames'
import { loadAsrProfiles } from '@/features/settings/asrProfileStore'
import { buildAsrProviderConfig, findAsrProvider, type AsrProviderConfig, type AsrProfile } from '@/features/settings/asrProviderCatalog'
import { releaseFileTranscription, reserveFileTranscription, setFileTranscriptionAdmissionReady } from './recorder'

export type FilePhase =
  | 'checking'
  | 'preparing'
  | 'loading'
  | 'transcribing'
  | 'finalizing'
  | 'cancelling'
  | 'completed'
  | 'no_speech'
  | 'cancelled'
  | 'failed'

export type FileTranscriptionEngine = 'local' | 'cloud'

export interface FileTranscriptionRequest {
  filePath: string
  outputDirectory: string
  modelId: string
  language: SpeechInputLanguage
  accelerator: string
  ffmpegDirectory: string | null
  audioStreamIndex: number | null
}

export interface FileTranscriptionEngineOptions {
  engine?: FileTranscriptionEngine
  cloudProfileId?: string | null
}

export interface FileTranscriptionCloudProfile {
  id: string
  label: string
  provider: string
  model: string
}

export interface FileTranscriptionCloudRequest {
  provider: string
  model: string
  label: string
  config: AsrProviderConfig
}

export interface FileTranscriptionSnapshot {
  jobId: string
  sequence: number
  phase: FilePhase
  engine: FileTranscriptionEngine
  cloudLabel: string | null
  durationMs: number | null
  processedMs: number
  savedMs: number
  text: string
  draftPath: string | null
  txtPath: string | null
  markdownPath: string | null
  error: string | null
  warning: string | null
  retryableExport: boolean
  resourcesReleased: boolean
}

export interface FileMediaInfo {
  durationMs: number | null
  audioTracks: Array<{ index: number; label: string; isDefault: boolean }>
}

export interface LocalFileSettings {
  modelId: string
  modelName: string
  modelInstalled: boolean
  language: SpeechInputLanguage
  accelerator: string
}

export interface FileTranscriptionStartOptions {
  filePath: string
  outputDirectory: string
  ffmpegDirectory: string | null
  audioStreamIndex: number | null
  engine?: FileTranscriptionEngine
  cloudProfileId?: string | null
}

export interface FileTranscriptionBridge {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>
  listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void>
}

export interface FileTranscriptionAdmission {
  reserveFileTranscription(): void
  releaseFileTranscription(): void
  setFileTranscriptionAdmissionReady?(ready: boolean): void
}

interface AvailableModel {
  id: string
  name: string
}

interface DownloadedModel {
  id: string
  complete: boolean
}

interface FileTranscriptionIpcRequest {
  filePath: string
  outputDirectory: string
  ffmpegDirectory: string | null
  audioStreamIndex: number | null
  engine: FileTranscriptionEngine
  cloud: FileTranscriptionCloudRequest | null
  modelId?: string
  language?: SpeechInputLanguage
  accelerator?: string
}

const defaultBridge: FileTranscriptionBridge = {
  invoke: <T>(command: string, args?: Record<string, unknown>) => bridge.invoke<T>(command, args),
  listen: <T>(event: string, handler: (event: { payload: T }) => void) => bridge.listen<T>(event, handler),
}

const defaultAdmission: FileTranscriptionAdmission = {
  reserveFileTranscription,
  releaseFileTranscription,
  setFileTranscriptionAdmissionReady,
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function formatFileDuration(durationMs: number | null): string {
  if (durationMs === null || durationMs < 0) return ''
  const totalSeconds = Math.floor(durationMs / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export function formatFilePathForDisplay(path: string): string {
  const trimmed = path.trim()
  if (trimmed.length <= 88) return trimmed
  return `${trimmed.slice(0, 40)}...${trimmed.slice(-45)}`
}

export function isRetryableExportFailure(snapshot: Pick<FileTranscriptionSnapshot, 'phase' | 'resourcesReleased' | 'retryableExport'>): boolean {
  return snapshot.phase === 'failed' && snapshot.resourcesReleased && snapshot.retryableExport
}

export class FileTranscriptionService {
  private snapshot: FileTranscriptionSnapshot | null = null
  private readonly listeners = new Set<() => void>()
  private unlisten: (() => void) | null = null
  private initialized = false
  private initPromise: Promise<void> | null = null
  private initializationError: string | null = null
  private epoch = 0
  private lastSequence = 0
  private reservationHeld = false
  private reservationJobId: string | null = null
  private inspectionGeneration = 0

  constructor(
    private readonly ipc: FileTranscriptionBridge = defaultBridge,
    private readonly admission: FileTranscriptionAdmission = defaultAdmission,
  ) {}

  getSnapshot = (): FileTranscriptionSnapshot | null => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getInitializationError = (): string | null => this.initializationError

  dispose = (): void => {
    this.epoch += 1
    this.unlisten?.()
    this.unlisten = null
    this.initialized = false
    this.initializationError = null
    this.releaseReservation()
  }

  async init(): Promise<void> {
    if (this.initialized && !this.initializationError) return
    if (this.initialized) this.initialized = false
    if (this.initPromise) return this.initPromise

    const generation = this.epoch
    this.admission.setFileTranscriptionAdmissionReady?.(false)
    const operation = (async () => {
      try {
        if (!this.unlisten) {
          const unlisten = await this.ipc.listen<FileTranscriptionSnapshot>(
            'file-transcription-state',
            (event) => this.receiveSnapshot(event.payload),
          )
          if (generation !== this.epoch) {
            unlisten()
            return
          }
          this.unlisten = unlisten
        }
        const current = await this.ipc.invoke<FileTranscriptionSnapshot | null>('get_file_transcription_state')
        if (generation !== this.epoch) return
        if (current) this.acceptSnapshot(current)
        this.initialized = true
        this.initializationError = null
        this.admission.setFileTranscriptionAdmissionReady?.(true)
        this.notify()
      } catch (error) {
        if (generation !== this.epoch) return
        this.initializationError = errorMessage(error)
        this.admission.setFileTranscriptionAdmissionReady?.(false)
        this.notify()
        throw error
      }
    })()
    this.initPromise = operation
    void operation.then(
      () => { if (this.initPromise === operation) this.initPromise = null },
      () => { if (this.initPromise === operation) this.initPromise = null },
    )
    return operation
  }

  async inspect(filePath: string, ffmpegDirectory: string | null): Promise<FileMediaInfo | null> {
    await this.init()
    const generation = ++this.inspectionGeneration
    try {
      const result = await this.ipc.invoke<FileMediaInfo>('inspect_transcription_file', {
        filePath,
        ffmpegDirectory,
      })
      return generation === this.inspectionGeneration ? result : null
    } catch (error) {
      if (generation !== this.inspectionGeneration) return null
      throw error
    }
  }

  async detectFfmpegDirectory(): Promise<string | null> {
    return this.ipc.invoke<string | null>('detect_ffmpeg_directory')
  }

  async getCloudProfiles(): Promise<FileTranscriptionCloudProfile[]> {
    const state = await loadAsrProfiles()
    return state.profiles.map((profile) => this.cloudProfileMetadata(profile))
  }

  async getLocalSettings(): Promise<LocalFileSettings> {
    const [modelIdValue, language, acceleratorValue, available, downloaded] = await Promise.all([
      getSetting('localAsr.modelId', 'sensevoice-small-gguf'),
      getSpeechInputLanguage(),
      getSetting('localAsr.accelerator', 'auto'),
      this.ipc.invoke<AvailableModel[]>('list_available_models'),
      this.ipc.invoke<DownloadedModel[]>('list_downloaded_models'),
    ])
    const modelId = String(modelIdValue || 'sensevoice-small-gguf')
    const catalogModel = available.find((model) => model.id === modelId)
    return {
      modelId,
      modelName: catalogModel ? localModelDisplayName(catalogModel) : modelId,
      modelInstalled: downloaded.some((model) => model.id === modelId && model.complete),
      language,
      accelerator: String(acceleratorValue || 'auto'),
    }
  }

  async start(request: FileTranscriptionRequest, options: FileTranscriptionEngineOptions = {}): Promise<FileTranscriptionSnapshot> {
    const engine = options.engine ?? 'local'
    return this.startReserved(engine, async () => {
      if (engine === 'cloud') {
        return this.buildCloudRequest({
          filePath: request.filePath,
          outputDirectory: request.outputDirectory,
          ffmpegDirectory: request.ffmpegDirectory,
          audioStreamIndex: request.audioStreamIndex,
        }, options.cloudProfileId, request.language)
      }
      return {
        ...request,
        engine: 'local',
        cloud: null,
      }
    })
  }

  async startWithCurrentSettings(options: FileTranscriptionStartOptions): Promise<FileTranscriptionSnapshot> {
    const { engine: requestedEngine, cloudProfileId, ...fileOptions } = options
    const engine = requestedEngine ?? 'local'
    return this.startReserved(engine, async () => {
      if (engine === 'cloud') {
        const language = await getSpeechInputLanguage()
        return this.buildCloudRequest(fileOptions, cloudProfileId, language)
      }
      const settings = await this.getLocalSettings()
      return {
        ...fileOptions,
        ...settings,
        engine: 'local',
        cloud: null,
      }
    })
  }

  private async startReserved(
    engine: FileTranscriptionEngine,
    loadRequest: () => Promise<FileTranscriptionIpcRequest>,
  ): Promise<FileTranscriptionSnapshot> {
    await this.init()
    const needsReservation = engine === 'local'
    if (needsReservation) {
      this.admission.reserveFileTranscription()
      this.reservationHeld = true
    }
    let pendingReservation = needsReservation
    try {
      const request = await loadRequest()
      const result = await this.ipc.invoke<FileTranscriptionSnapshot>('start_file_transcription', { request })
      const accepted = this.acceptSnapshot(result)
      if (accepted) {
        if (result.resourcesReleased && needsReservation) this.releaseReservation()
        else if (needsReservation) this.reservationJobId = result.jobId
      } else if (this.snapshot?.resourcesReleased) {
        if (needsReservation) this.releaseReservation()
      }
      pendingReservation = false
      return accepted ? result : (this.snapshot ?? result)
    } catch (error) {
      if (pendingReservation && this.reservationJobId === null) this.releaseReservation()
      throw error
    }
  }

  async cancel(): Promise<void> {
    await this.init()
    const jobId = this.snapshot?.jobId
    if (!jobId || !this.snapshot || this.snapshot.resourcesReleased) {
      throw new Error('No active file transcription job')
    }
    await this.ipc.invoke<void>('cancel_file_transcription', { jobId })
  }

  async retryExport(jobId: string): Promise<FileTranscriptionSnapshot> {
    await this.init()
    if (this.snapshot?.jobId !== jobId) throw new Error('File transcription job is no longer current')
    const result = await this.ipc.invoke<FileTranscriptionSnapshot>('retry_file_transcription_export', { jobId })
    this.acceptSnapshot(result)
    return result
  }

  async copyText(text: string): Promise<void> {
    await bridge.copyText(text)
  }

  private receiveSnapshot(next: FileTranscriptionSnapshot): void {
    try {
      this.acceptSnapshot(next)
    } catch (error) {
      this.initializationError = errorMessage(error)
      this.admission.setFileTranscriptionAdmissionReady?.(false)
      this.notify()
    }
  }

  private acceptSnapshot(next: FileTranscriptionSnapshot): boolean {
    if (next.sequence <= this.lastSequence) return false
    const currentIsActive = this.snapshot !== null && !this.snapshot.resourcesReleased
    if (currentIsActive && this.snapshot?.jobId !== next.jobId) return false

    const needsReservation = next.engine === 'local' && !next.resourcesReleased
    if (needsReservation && !this.reservationHeld) {
      this.admission.reserveFileTranscription()
      this.reservationHeld = true
    }
    this.lastSequence = next.sequence
    this.snapshot = next
    if (next.resourcesReleased) {
      if (this.reservationJobId === next.jobId) this.releaseReservation()
    } else if (next.engine === 'local') {
      this.reservationJobId = next.jobId
    } else if (this.reservationJobId === next.jobId) {
      this.releaseReservation()
    }
    this.notify()
    return true
  }

  private releaseReservation(): void {
    if (!this.reservationHeld) return
    this.admission.releaseFileTranscription()
    this.reservationHeld = false
    this.reservationJobId = null
  }

  private cloudProfileMetadata(profile: AsrProfile): FileTranscriptionCloudProfile {
    return {
      id: profile.id,
      label: findAsrProvider(profile.provider)?.label ?? profile.provider,
      provider: profile.provider,
      model: profile.model,
    }
  }

  private async buildCloudRequest(
    options: FileTranscriptionStartOptions,
    cloudProfileId: string | null | undefined,
    language: SpeechInputLanguage,
  ): Promise<FileTranscriptionIpcRequest> {
    if (!cloudProfileId) throw new Error('A cloud ASR profile must be selected')
    const state = await loadAsrProfiles()
    const profile = state.profiles.find(({ id }) => id === cloudProfileId)
    if (!profile) throw new Error(`Cloud ASR profile not found: ${cloudProfileId}`)
    const profileSnapshot = { ...profile }
    const metadata = this.cloudProfileMetadata(profileSnapshot)
    const cloud = {
      provider: metadata.provider,
      model: metadata.model,
      label: metadata.label,
    }
    return {
      ...options,
      engine: 'cloud',
      cloud: {
        ...cloud,
        config: buildAsrProviderConfig(profileSnapshot, language),
      },
    }
  }

  private notify(): void {
    this.listeners.forEach((listener) => listener())
  }
}

export const fileTranscriptionService = new FileTranscriptionService()

// HMR cleanup: release the Tauri listener and file reservation so a hot-replaced module cannot double-consume state events
if ((import.meta as unknown as Record<string, unknown>).hot) {
  const hot = (import.meta as unknown as Record<string, unknown>).hot as { dispose: (cb: () => void) => void }
  hot.dispose(() => {
    console.log('[fileTranscription] HMR dispose: unsubscribing state listener')
    fileTranscriptionService.dispose()
  })
}
