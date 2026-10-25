// ASR test card — runs the bundled test clip through the current recognition mode.

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Play, Pause } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Feedback } from '@/components/ui/feedback'
import { getSelectedLocalModelId } from '@/services/localModelStatus'
import { getEngineDraftDirty, subscribeEngineDraft } from '@/stores/engineDraft'
import { resolveAsrDisplayModel, resolveQwenOmniModel } from '@/lib/asrModels'
import { buildAsrProviderConfig, CUSTOM_ASR_PROVIDER, findAsrProvider } from './asrProviderCatalog'
import { loadActiveAsrProfile } from './asrProfileStore'
import { describeProviderError, describeServerError } from '@/lib/errorMessages'
import type { WorkMode } from '@/services/transcription'
import { useT } from '@/i18n/useT'
import { type SpeechInputLanguage } from '@/services/speechInputLanguage'
import { transcribeCustomAsr } from '@/services/transcription/customAsrRequest'
import { prepareTestPcm } from './testAudio'

interface TestResult {
  text: string
  asrMs: number
  mode: WorkMode
  model: string
  audioDurationSec: number
}

interface TestError {
  message: string
  detail?: string
}

export default function AsrTestSection({ workMode, speechLanguage }: { workMode: WorkMode; speechLanguage: SpeechInputLanguage }) {
  const t = useT()
  const [testing, setTesting] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [result, setResult] = useState<TestResult | null>(null)
  // Failures used to be written into result.text, so they rendered in the same
  // panel as successes with an "ASR 0ms" badge — a failure looked like a
  // successful recognition of the words "Test failed:".
  const [error, setError] = useState<TestError | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const testRunIdRef = useRef(0)

  // With unsaved edits above, this card reads stale values, so a result would be meaningless
  const draftDirty = useSyncExternalStore(subscribeEngineDraft, getEngineDraftDirty)

  // Switching the work mode invalidates old results; drop them.
  useEffect(() => {
    testRunIdRef.current += 1
    setTesting(false)
    setResult(null)
    setError(null)
  }, [workMode])

  async function handlePlay() {
    if (playing && audioRef.current) {
      audioRef.current.pause()
      audioRef.current.currentTime = 0
      setPlaying(false)
      return
    }
    try {
      const b64 = await invoke<string>('get_test_audio_b64', { language: speechLanguage })
      const audio = new Audio(`data:audio/wav;base64,${b64}`)
      audioRef.current = audio
      audio.onended = () => setPlaying(false)
      setPlaying(true)
      await audio.play()
    } catch {
      setPlaying(false)
    }
  }

  async function handleTest() {
    const testRunId = ++testRunIdRef.current
    const isCurrentTest = () => testRunIdRef.current === testRunId
    setTesting(true)
    setResult(null)
    setError(null)
    let customProfileTest = false

    try {
      const cloudProfile = workMode === 'cloud_api' ? await loadActiveAsrProfile() : null
      // Fetch the test clip for the selected language and prepare raw PCM
      const { pcmB64, pcmBytes, audioSec: audioDurationSec } = await prepareTestPcm(speechLanguage)

      if (workMode === 'local') {
        const modelId = await getSelectedLocalModelId()
        const r = await invoke<{ text: string; elapsed_ms: number; model_id: string }>('run_asr_benchmark', {
          modelId, language: speechLanguage,
        })
        setResult({ text: r.text, asrMs: r.elapsed_ms, mode: 'local', model: r.model_id, audioDurationSec })
      } else if (workMode === 'cloud_api') {
        const profile = cloudProfile
        if (!profile) throw new Error('No cloud ASR profile is active')
        customProfileTest = profile.provider === CUSTOM_ASR_PROVIDER
        const entry = findAsrProvider(profile.provider)
        const qwenOmniModel = entry?.omni ? resolveQwenOmniModel(profile.provider) : undefined

        const start = performance.now()
        const r = profile.provider === CUSTOM_ASR_PROVIDER
          ? await transcribeCustomAsr({
            profile,
            audioB64: pcmB64,
            sampleRate: 16000,
            language: speechLanguage,
            hotwords: [],
            isCurrent: isCurrentTest,
          })
          : await invoke<{ text: string; elapsed_ms: number }>('cloud_transcribe', {
            request: {
              audio_b64: pcmB64,
              sample_rate: 16000,
              asr_config: buildAsrProviderConfig(profile, speechLanguage),
            },
          })
        if (!r || !isCurrentTest()) return
        const totalMs = Math.round(performance.now() - start)
        setResult({
          text: r.text,
          asrMs: totalMs,
          mode: 'cloud_api',
          model: entry?.omni
            ? qwenOmniModel || profile.model
            : entry?.models || entry?.customEndpoint ? profile.model : resolveAsrDisplayModel(profile.provider),
          audioDurationSec,
        })
      } else {
        // Server mode
        const { getWSUrl, serverNotConfiguredMessage } = await import('@/services/runtimeConfig')
        const wsUrl = getWSUrl()
        if (!wsUrl) {
          setError({ message: serverNotConfiguredMessage() })
          return
        }

        const r = await new Promise<{ text: string; asrMs: number }>((resolve, reject) => {
          const timeout = setTimeout(() => {
            try { sock.close() } catch { /* Ignore cleanup failures after timeout. */ }
            reject(new Error(t('asrTest.timeout')))
          }, 30000)
          const sock = new WebSocket(wsUrl)
          sock.binaryType = 'arraybuffer'
          sock.onopen = () => {
            sock.send(JSON.stringify({ cmd: 'start', disable_ai: true, language: speechLanguage }))
            // Send PCM in chunks (3200 bytes = 100 ms of 16 kHz 16-bit mono)
            const chunkSize = 3200
            for (let i = 0; i < pcmBytes.length; i += chunkSize) {
              sock.send(pcmBytes.slice(i, i + chunkSize).buffer)
            }
            sock.send(JSON.stringify({ cmd: 'stop' }))
          }
          sock.onmessage = (e) => {
            if (typeof e.data !== 'string') return
            try {
              const msg = JSON.parse(e.data)
              if (msg.type === 'final') {
                clearTimeout(timeout)
                resolve({ text: msg.asr_text || '', asrMs: msg.asr_ms || 0 })
                sock.close()
              } else if (msg.type === 'error') {
                clearTimeout(timeout)
                reject(new Error(msg.message || t('asrTest.serverError')))
                sock.close()
              }
            } catch { /* Ignore malformed WebSocket messages and keep waiting. */ }
          }
          sock.onerror = () => { clearTimeout(timeout); reject(new Error(t('asrTest.wsFailed'))) }
        })

        setResult({ text: r.text, asrMs: r.asrMs, mode: 'server', model: '', audioDurationSec })
      }
    } catch (err) {
      if (customProfileTest && !isCurrentTest()) return
      const friendly = workMode === 'server'
        ? describeServerError(err, true)
        : describeProviderError(err)
      setError({ message: friendly.message, detail: friendly.detail })
    } finally {
      if (isCurrentTest()) setTesting(false)
    }
  }

  return (
    <Card>
      <CardContent className="p-6">
        {/* flex-wrap: at the minimum window size the title and both buttons overflow one row */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">{t('asrTest.title')}</h2>
            {/* This card tests ASR only. In server mode the request carries
                disable_ai: true, and local and cloud API runs skip AI cleanup as
                well. The UI used to render a constant "LLM 0ms", making users
                think cleanup was broken; the scope is stated and the fake field
                is gone. */}
            <p className="mt-1 text-xs text-muted-foreground">
              {t('asrTest.desc')}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void handlePlay()}>
              {playing ? <Pause className="h-3.5 w-3.5" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
              {playing ? t('asrTest.pause') : t('asrTest.play')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void handleTest()}
              disabled={testing || draftDirty}
            >
              {testing ? t('asrTest.testing') : t('asrTest.start')}
            </Button>
          </div>
        </div>

        {/* The test reads saved configuration. Testing right after pasting a key
            would fail and users would misjudge the key as broken. */}
        {draftDirty && (
          <Feedback
            className="mt-4"
            tone="warning"
            message={t('asrTest.unsavedWarning')}
          />
        )}

        {error && (
          <Feedback
            className="mt-4"
            tone="error"
            message={t('asrTest.failed', { message: error.message })}
            detail={error.detail}
            actions={[{ label: t('common.retry'), onClick: () => void handleTest(), disabled: testing }]}
          />
        )}

        {result && (
          <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="rounded bg-primary/10 px-2 py-0.5 text-primary">
                {t(result.mode === 'local' ? 'asrTest.modeLocal' : result.mode === 'cloud_api' ? 'asrTest.modeCloudApi' : 'asrTest.modeServer')}
              </span>
              <span className="rounded bg-muted px-2 py-0.5">{result.mode === 'server' ? t('asrTest.serverModel') : result.model}</span>
              <span>{t('asrTest.audioLen', { sec: result.audioDurationSec.toFixed(1) })}</span>
              <span>{t('asrTest.elapsed', { ms: result.asrMs })}</span>
            </div>
            <p className="mt-2 text-sm text-foreground">{result.text || t('asrTest.noResult')}</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
