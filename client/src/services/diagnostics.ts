import * as bridge from './bridge'
import { invoke } from '@tauri-apps/api/core'
import { getSetting } from './store'
import { getSpeechInputLanguage } from './speechInputLanguage'
import { getWorkMode } from './transcription'
import { buildAsrProviderConfig, type AsrProfile } from '@/features/settings/asrProviderCatalog'
import type { DiagnosticOccurrence, DiagnosticsPreview, PublicDiagnosticsEnvironment } from '@/types/appApi'

const WORK_MODES = new Set(['local', 'server', 'cloud_api'])
const ACCELERATORS = new Set(['cpu', 'cuda', 'vulkan', 'auto'])
// ASR provider ids from the catalog plus AI provider ids. Consulted only when
// the work mode itself is unknown; keep the ASR entries in sync with
// ASR_PROVIDERS so a provider is never classified as unknown.
const CLOUD_PROVIDERS = new Set([
  'doubao_v2',
  'qwen',
  'qwen_realtime',
  'qwen_audio_stream',
  'qwen_omni_35_plus',
  'qwen_omni_35_flash',
  'qwen_omni_38_realtime',
  'qwen_omni_flash',
  'qwen_omni_turbo',
  'mimo',
  'groq_whisper',
  'deepgram',
  'openai_transcribe',
  'gemini_transcribe',
  'openrouter_transcribe',
  'openai',
  'openai_compat',
  'deepseek',
  'ollama',
  'doubao',
  'groq',
  'opencode_go',
])

function normalizeProvider(value: unknown, mode: string): 'local' | 'server' | 'cloud' | 'unknown' {
  if (mode === 'local') return 'local'
  if (mode === 'server') return 'server'
  if (mode === 'cloud_api') return 'cloud'
  if (value === 'local' || value === 'server' || value === 'cloud') return value
  if (typeof value === 'string' && CLOUD_PROVIDERS.has(value)) return 'cloud'
  return 'unknown'
}

function normalizeWorkMode(value: unknown): PublicDiagnosticsEnvironment['workMode'] {
  return typeof value === 'string' && WORK_MODES.has(value)
    ? (value as PublicDiagnosticsEnvironment['workMode'])
    : 'unknown'
}

function normalizeAccelerator(value: unknown): PublicDiagnosticsEnvironment['localAccelerator'] {
  return typeof value === 'string' && ACCELERATORS.has(value)
    ? (value as PublicDiagnosticsEnvironment['localAccelerator'])
    : 'unknown'
}

export async function collectPublicDiagnosticsEnvironment(): Promise<PublicDiagnosticsEnvironment> {
  const workMode = normalizeWorkMode(getWorkMode())
  const [speechInputLanguage, aiEnabledValue, asrProviderValue, aiProviderValue, acceleratorValue] = await Promise.all([
    getSpeechInputLanguage(),
    getSetting('aiEnabled', false),
    getSetting('cloudAsr.provider', ''),
    getSetting('cloudAi.provider', ''),
    getSetting('localAsr.accelerator', 'auto'),
  ])
  const aiEnabled = aiEnabledValue === true

  return {
    workMode,
    speechInputLanguage,
    aiEnabled,
    asrProvider: normalizeProvider(asrProviderValue, workMode),
    aiProvider: aiEnabled
      ? workMode === 'server'
        ? 'server'
        : workMode === 'cloud_api'
          ? 'cloud'
          : aiProviderValue === 'server'
            ? 'server'
            : typeof aiProviderValue === 'string' && CLOUD_PROVIDERS.has(aiProviderValue)
              ? 'cloud'
              : 'unknown'
      : 'none',
    localAccelerator: normalizeAccelerator(acceleratorValue),
  }
}

export async function testAsrConnection(
  profile: AsrProfile,
  language: Awaited<ReturnType<typeof getSpeechInputLanguage>>,
): Promise<{ ok: boolean; message: string }> {
  return invoke<{ ok: boolean; message: string }>('test_asr_connection', {
    config: buildAsrProviderConfig(profile, language),
  })
}

export async function getDiagnosticsPreview(issueOccurrence: DiagnosticOccurrence): Promise<DiagnosticsPreview> {
  const preview = await bridge.getDiagnosticsPreview(issueOccurrence)
  if (!preview) throw new Error('Failed to collect diagnostics preview')
  return preview
}

export async function createSupportBundle(issueOccurrence: DiagnosticOccurrence): Promise<string> {
  const environment = await collectPublicDiagnosticsEnvironment()
  const source = await bridge.createPublicDiagnosticsBundle({ issueOccurrence, environment })
  if (!source) throw new Error('Failed to create support bundle')
  return source
}

export async function saveSupportBundle(issueOccurrence: DiagnosticOccurrence, destination: string): Promise<string> {
  const source = await createSupportBundle(issueOccurrence)
  await bridge.copyDiagnosticsZip(source, destination)
  return destination
}
