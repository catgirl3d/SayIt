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

export default function AudioSettingsPage() {
  const t = useT()
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [selectedMic, setSelectedMic] = useState('')
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

  const stopMicTest = useCallback(() => {
    if (cleanupTestRef.current) {
      cleanupTestRef.current()
      cleanupTestRef.current = null
    }
    setTesting(false)
  }, [])

  useEffect(() => {
    return () => {
      if (cleanupTestRef.current) {
        cleanupTestRef.current()
        cleanupTestRef.current = null
      }
    }
  }, [])

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
    setTesting(true)
    setVolumeLevel('idle')
    setMicError('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: selectedMic ? { deviceId: { exact: selectedMic } } : true,
      })
      const context = new AudioContext()
      const source = context.createMediaStreamSource(stream)
      const gainNode = context.createGain()
      const boostConfig = resolveMicBoost(micBoost)
      gainNode.gain.value = boostConfig.gain
      source.connect(gainNode)
      const analyser = context.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.7
      gainNode.connect(analyser)
      resetWaveform()
      drawWaveform(analyser)

      const dataArray = new Float32Array(analyser.frequencyBinCount)
      let peakRms = 0
      let sawNonZeroSignal = false
      const volumeCheckId = setInterval(() => {
        analyser.getFloatTimeDomainData(dataArray)
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

      cleanupTestRef.current = () => {
        clearTimeout(timerId)
        clearInterval(volumeCheckId)
        cancelAnimationFrame(animRef.current)
        stream.getTracks().forEach((t) => t.stop())
        try { source.disconnect() } catch { /* ignore */ }
        try { gainNode.disconnect() } catch { /* ignore */ }
        try { analyser.disconnect() } catch { /* ignore */ }
        void context.close().catch(() => { })
      }
    } catch (err) {
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
