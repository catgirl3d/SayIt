import { invoke } from '@tauri-apps/api/core'
import { buildAsrProviderConfig, type AsrProfile } from '@/features/settings/asrProviderCatalog'
import { errorProtocolCode } from '@/lib/errorMessages'
import type { SpeechInputLanguage } from '../speechInputLanguage'

interface CustomAsrResult {
  text: string
  elapsed_ms: number
}

interface CustomAsrInput {
  profile: AsrProfile
  audioB64: string
  sampleRate: number
  language: SpeechInputLanguage
  hotwords: readonly string[]
  isCurrent: () => boolean
}

interface CloudTranscribeRequest {
  audio_b64: string
  sample_rate: number
  asr_config: ReturnType<typeof buildAsrProviderConfig>
  hotwords: string[]
}

const AUTO_PROTOCOL_MISMATCH_CODE = 'asr_protocol_mismatch'
type CustomAsrProtocol = 'transcriptions' | 'chat'
const successfulAutoProtocol = new Map<string, CustomAsrProtocol>()

function makeRequest(input: CustomAsrInput): CloudTranscribeRequest {
  return {
    audio_b64: input.audioB64,
    sample_rate: input.sampleRate,
    asr_config: buildAsrProviderConfig(input.profile, input.language),
    hotwords: [...input.hotwords],
  }
}

function autoProtocolCacheKey(profileId: string, request: CloudTranscribeRequest): string {
  const extra = request.asr_config.extra ?? {}
  const rawBaseUrl = typeof extra.base_url === 'string' ? extra.base_url.trim() : ''
  let baseUrl: string
  try {
    const url = new URL(rawBaseUrl)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    url.pathname = url.pathname
      .replace(/\/(?:audio\/transcriptions|chat\/completions)\/?$/, '')
      .replace(/\/+$/, '')
    baseUrl = url.toString()
  } catch {
    baseUrl = ''
  }
  const model = typeof extra.model === 'string' ? extra.model.trim() : ''
  return JSON.stringify([profileId, baseUrl, model])
}

function withProtocol(request: CloudTranscribeRequest, protocol: 'transcriptions' | 'chat'): CloudTranscribeRequest {
  return {
    ...request,
    asr_config: {
      ...request.asr_config,
      extra: { ...(request.asr_config.extra ?? {}), protocol },
    },
  }
}

async function send(request: CloudTranscribeRequest): Promise<CustomAsrResult> {
  return invoke<CustomAsrResult>('cloud_transcribe', { request })
}

export async function transcribeCustomAsr(input: CustomAsrInput): Promise<CustomAsrResult | null> {
  if (!input.isCurrent()) return null
  const profile = { ...input.profile }
  const request = makeRequest({ ...input, profile })
  const configuredProtocol = profile.protocol ?? 'transcriptions'
  if (configuredProtocol !== 'auto') {
    try {
      const result = await send(request)
      return input.isCurrent() ? result : null
    } catch (error) {
      if (!input.isCurrent()) return null
      throw error
    }
  }

  const cacheKey = autoProtocolCacheKey(profile.id, request)
  const cachedProtocol = successfulAutoProtocol.get(cacheKey)
  if (cachedProtocol) {
    try {
      const result = await send(withProtocol(request, cachedProtocol))
      if (!input.isCurrent()) return null
      successfulAutoProtocol.set(cacheKey, cachedProtocol)
      return result
    } catch (error) {
      if (!input.isCurrent()) return null
      throw error
    }
  }

  try {
    const result = await send(withProtocol(request, 'transcriptions'))
    if (!input.isCurrent()) return null
    successfulAutoProtocol.set(cacheKey, 'transcriptions')
    return result
  } catch (error) {
    if (!input.isCurrent()) return null
    if (errorProtocolCode(error) !== AUTO_PROTOCOL_MISMATCH_CODE) {
      throw error
    }
    try {
      const result = await send(withProtocol(request, 'chat'))
      if (!input.isCurrent()) return null
      successfulAutoProtocol.set(cacheKey, 'chat')
      return result
    } catch (chatError) {
      if (!input.isCurrent()) return null
      throw chatError
    }
  }
}
