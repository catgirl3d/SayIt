import { useState, useEffect, useRef, useCallback } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import MicrophoneSection, { type MicVolumeLevel } from './MicrophoneSection'
import { listMicrophones } from '@/services/audio'
import { getSetting, setSetting } from '@/services/store'
import { refreshRecorderSettings } from '@/services/recorder'
import { DEFAULT_MIC_BOOST, resolveMicBoost, type MicBoostSetting } from '@/services/defaults'
import { drawBars, resetWaveform } from '@/services/waveform'
import { useT } from '@/i18n/useT'
import { resolveMicPlan, type MicPlan } from '@/services/micRouting'

export default function AudioSettingsPage() {
  const t = useT()
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [selectedMic, setSelectedMic] = useState('')
  const [micPlan, setMicPlan] = useState<MicPlan | null>(null)
  const [micBoost, setMicBoost] = useState<MicBoostSetting>(DEFAULT_MIC_BOOST)
  const [testing, setTesting] = useState(false)
  const [volumeLevel, setVolumeLevel] = useState<MicVolumeLevel>('idle')
  const [micError, setMicError] = useState('')
  const [muteSystemAudio, setMuteSystemAudio] = useState(false)
  const [readySoundEnabled, setReadySoundEnabled] = useState(true)
  const [ready, setReady] = useState(false)
  const [animate, setAnimate] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const animRef = useRef<number>(0)
  const cleanupTestRef = useRef<(() => void) | null>(null)
  const testAttemptRef = useRef(0)

  const stopMicTest = useCallback(() => {
    if (cleanupTestRef.current) {
      cleanupTestRef.current()
      cleanupTestRef.current = null
    }
    setTesting(false)
  }, [])

  useEffect(() => {
    return () => {
      testAttemptRef.current++
      if (cleanupTestRef.current) {
        cleanupTestRef.current()
        cleanupTestRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void resolveMicPlan(selectedMic, { webDevices: mics }).then(({ plan }) => {
      if (!cancelled) setMicPlan(plan)
    })
    return () => { cancelled = true }
  }, [mics, selectedMic])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [mute, readySound, boost] = await Promise.all([
        getSetting('muteSystemAudioWhileRecording', false).catch(() => false),
        getSetting('readySoundEnabled', true).catch(() => true),
        getSetting('micBoost', DEFAULT_MIC_BOOST).catch(() => DEFAULT_MIC_BOOST),
      ])
      if (cancelled) return
      setMuteSystemAudio(Boolean(mute))
      setReadySoundEnabled(Boolean(readySound))
      setMicBoost(resolveMicBoost(boost).setting)
      setReady(true)
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!cancelled) setAnimate(true)
      }))
    })()

    getSetting('selectedMic', '').then(setSelectedMic).catch(() => { })
    listMicrophones().then(setMics).catch(() => { })
    return () => { cancelled = true }
  }, [])

  const handleMicChange = async (deviceId: string) => {
    setSelectedMic(deviceId)
    await setSetting('selectedMic', deviceId)
    await refreshRecorderSettings()
  }

  const handleMicBoostChange = async (value: MicBoostSetting) => {
    const next = resolveMicBoost(value).setting
    setMicBoost(next)
    await setSetting('micBoost', next)
  }

  const toggleMuteSystemAudio = async () => {
    const next = !muteSystemAudio
    setMuteSystemAudio(next)
    await setSetting('muteSystemAudioWhileRecording', next)
    await refreshRecorderSettings()
  }

  const toggleReadySound = async () => {
    const next = !readySoundEnabled
    setReadySoundEnabled(next)
    await setSetting('readySoundEnabled', next)
    await refreshRecorderSettings()
  }

  const drawWaveform = useCallback((analyser: AnalyserNode) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return
    const draw = () => {
      drawBars(context, analyser, canvas.width, canvas.height)
      animRef.current = requestAnimationFrame(draw)
    }
    draw()
  }, [])

  const testMic = async () => {
    if (testing) return
    stopMicTest()
    const attempt = ++testAttemptRef.current
    setTesting(true)
    setVolumeLevel('idle')
    setMicError('')
    let stream: MediaStream | null = null
    let context: AudioContext | null = null
    let source: MediaStreamAudioSourceNode | null = null
    let gainNode: GainNode | null = null
    let analyser: AnalyserNode | null = null
    const openStream = (deviceId: string) => navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
    })
    const releaseStream = () => {
      const opened = stream
      stream = null
      opened?.getTracks().forEach((track) => track.stop())
    }
    const releaseAttempt = () => {
      releaseStream()
      try { source?.disconnect() } catch { /* ignore */ }
      try { gainNode?.disconnect() } catch { /* ignore */ }
      try { analyser?.disconnect() } catch { /* ignore */ }
      if (context) void context.close().catch(() => undefined)
    }
    try {
      const { plan } = await resolveMicPlan(selectedMic)
      if (attempt !== testAttemptRef.current) return

      stream = await openStream(plan.deviceId)
      if (attempt !== testAttemptRef.current) {
        releaseAttempt()
        return
      }
      cleanupTestRef.current = releaseAttempt

      if (plan.reason === 'unmapped') {
        const { plan: retry } = await resolveMicPlan('', {
          openedDefaultLabel: stream.getAudioTracks()[0]?.label ?? '',
        })
        if (attempt !== testAttemptRef.current) return
        if (retry.reason === 'virtual_avoided') {
          releaseStream()
          stream = await openStream(retry.deviceId)
          if (attempt !== testAttemptRef.current) {
            releaseAttempt()
            return
          }
        }
      }

      context = new AudioContext()
      source = context.createMediaStreamSource(stream)
      gainNode = context.createGain()
      const boostConfig = resolveMicBoost(micBoost)
      gainNode.gain.value = boostConfig.gain
      source.connect(gainNode)
      analyser = context.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.7
      gainNode.connect(analyser)
      resetWaveform()
      drawWaveform(analyser)

      const dataArray = new Float32Array(analyser.frequencyBinCount)
      let peakRms = 0
      let sawNonZeroSignal = false
      const volumeCheckId = setInterval(() => {
        analyser?.getFloatTimeDomainData(dataArray)
        let sum = 0
        for (let i = 0; i < dataArray.length; i++) {
          const v = dataArray[i]
          sum += v * v
          if (v !== 0) sawNonZeroSignal = true
        }
        const rms = Math.sqrt(sum / dataArray.length)
        if (rms > peakRms) peakRms = rms
        if (!sawNonZeroSignal) setVolumeLevel('silent')
        else if (peakRms < 0.02) setVolumeLevel('low')
        else setVolumeLevel('normal')
      }, 500)

      const timerId = setTimeout(() => {
        stopMicTest()
      }, 5000)

      const cleanup = () => {
        clearTimeout(timerId)
        clearInterval(volumeCheckId)
        cancelAnimationFrame(animRef.current)
        releaseAttempt()
      }
      if (attempt !== testAttemptRef.current) {
        cleanup()
        return
      }
      cleanupTestRef.current = cleanup
    } catch (err) {
      if (attempt !== testAttemptRef.current) {
        releaseAttempt()
        return
      }
      stopMicTest()
      const msg = err instanceof DOMException && err.name === 'NotFoundError'
        ? t('mic.error.notFound')
        : err instanceof DOMException && err.name === 'NotAllowedError'
          ? t('mic.error.denied')
          : t('mic.error.failed')
      setMicError(msg)
      setVolumeLevel('idle')
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-6 text-2xl font-bold">{t('nav.audio')}</h1>
      <div className="space-y-6">
        <MicrophoneSection
          mics={mics}
          selectedMic={selectedMic}
          testing={testing}
          volumeLevel={volumeLevel}
          micBoost={micBoost}
          onMicBoostChange={(val) => { void handleMicBoostChange(val) }}
          ready={ready}
          animate={animate}
          onCanvasRef={(node) => { canvasRef.current = node }}
          onMicChange={handleMicChange}
          onTestMic={testMic}
          errorMessage={micError}
        />
        {!selectedMic && micPlan?.reason === 'virtual_avoided' && (
          <p className="-mt-4 text-xs text-muted-foreground">
            {t('mic.virtualDefaultNote', { virtual: micPlan.avoidedName, name: micPlan.chosenName })}
          </p>
        )}

        <Card>
          <CardContent className="space-y-4 p-6">
            <h2 className="text-lg font-semibold">{t('settings.prefs.title')}</h2>
            <div className="flex items-center justify-between">
              <div>
                <p id="ready-sound-label" className="text-sm font-medium">{t('settings.prefs.readySound')}</p>
                <p className="text-xs text-muted-foreground">{t('settings.prefs.readySoundDesc')}</p>
              </div>
              <Switch labelledBy="ready-sound-label" checked={readySoundEnabled} onChange={() => void toggleReadySound()} noAnimation={!animate} hidden={!ready} />
            </div>
            <div className="flex items-center justify-between border-t border-border pt-4">
              <div>
                <p id="mute-system-audio-label" className="text-sm font-medium">{t('settings.prefs.muteSystemAudio')}</p>
                <p className="text-xs text-muted-foreground">{t('settings.prefs.muteSystemAudioDesc')}</p>
              </div>
              <Switch labelledBy="mute-system-audio-label" checked={muteSystemAudio} onChange={() => void toggleMuteSystemAudio()} noAnimation={!animate} hidden={!ready} />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
