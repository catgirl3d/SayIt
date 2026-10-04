import { useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Select, type SelectOption } from '@/components/ui/select'
import { Segmented } from '@/components/ui/segmented'
import { cleanMicLabel } from './utils'
import { cleanActiveMicLabel } from '@/services/recorder/micSourceReminder'
import type { TranslationKey } from '@/i18n'
import { useT } from '@/i18n/useT'
import type { MicBoostSetting } from '@/services/defaults'

export type MicVolumeLevel = 'idle' | 'silent' | 'low' | 'normal'

/** Store translation keys: module-level constants are evaluated once, so stored translations would not update on a language change. */
const VOLUME_CONFIG: Record<MicVolumeLevel, { labelKey: TranslationKey | null; color: string; descKey: TranslationKey | null }> = {
  idle: { labelKey: null, color: '', descKey: null },
  silent: { labelKey: 'mic.level.silent', color: 'text-destructive', descKey: 'mic.level.silentDesc' },
  low: { labelKey: 'mic.level.low', color: 'text-amber-500', descKey: 'mic.level.lowDesc' },
  normal: { labelKey: 'mic.level.normal', color: 'text-emerald-500', descKey: 'mic.level.normalDesc' },
}

/** Resolve the physical device a Chromium pseudo-route ("default"/"communications") points at, when the group match is unambiguous. */
function resolvePseudoRouteName(devices: MediaDeviceInfo[], groupId: string): string {
  const target = groupId.trim()
  if (!target) return ''
  const matches = devices.filter((mic) =>
    mic.deviceId !== 'default' && mic.deviceId !== 'communications' && mic.groupId.trim() === target)
  return matches.length === 1 ? cleanMicLabel(matches[0].label) : ''
}

/** Chromium exposes the default and communications roles as separate routes that can point at the same endpoint; group ids identify the physical device when present. */
function isSameRouteTarget(a: MediaDeviceInfo, b: MediaDeviceInfo): boolean {
  const groupA = a.groupId.trim()
  const groupB = b.groupId.trim()
  if (groupA && groupB) return groupA === groupB
  const labelA = cleanActiveMicLabel(a.label).toLocaleLowerCase()
  const labelB = cleanActiveMicLabel(b.label).toLocaleLowerCase()
  return Boolean(labelA) && labelA === labelB
}

export default function MicrophoneSection({
  mics,
  selectedMic,
  testing,
  volumeLevel,
  micBoost,
  errorMessage,
  ready,
  animate,
  onCanvasRef,
  onMicChange,
  onTestMic,
  onMicBoostChange,
}: {
  mics: MediaDeviceInfo[]
  selectedMic: string
  testing: boolean
  volumeLevel: MicVolumeLevel
  micBoost: MicBoostSetting
  errorMessage?: string
  ready: boolean
  animate: boolean
  onCanvasRef: (node: HTMLCanvasElement | null) => void
  onMicChange: (deviceId: string) => void
  onTestMic: () => void
  onMicBoostChange: (value: MicBoostSetting) => void
}) {
  const t = useT()
  const micOptions = useMemo(() => {
    const defaults = mics.filter((mic) => mic.deviceId === 'default')
    const visible = new Map<string, MediaDeviceInfo>()
    for (const mic of mics) {
      if (!mic.deviceId || mic.deviceId === 'default') continue
      const previous = visible.get(mic.deviceId)
      if (!previous || (!previous.label && mic.label)) visible.set(mic.deviceId, mic)
    }

    const devices = [...visible.values()]
    const defaultEntry = defaults.length && defaults.every((mic) => mic.groupId === defaults[0].groupId)
      ? defaults[0] : null
    const defaultGroup = defaultEntry?.groupId ?? ''
    const defaultName = resolvePseudoRouteName(devices, defaultGroup)
    const options: SelectOption[] = [
      { value: '', label: defaultName ? t('mic.systemDefaultWithDevice', { name: defaultName }) : t('mic.systemDefault') },
    ]
    // A saved browser "default" ID must remain distinct from the app's empty system-default value.
    if (selectedMic === 'default') {
      options.push({ value: selectedMic, label: t('mic.savedDefault') })
    }
    // The communications route duplicates the system default when both resolve to the same device; keep it visible only when it is the saved selection.
    const communications = visible.get('communications')
    const hideCommunications = Boolean(communications && defaultEntry && selectedMic !== 'communications' &&
      isSameRouteTarget(communications, defaultEntry))
    for (const mic of devices) {
      if (mic.deviceId === 'communications') {
        if (hideCommunications) continue
        const name = resolvePseudoRouteName(devices, mic.groupId) || cleanActiveMicLabel(mic.label)
        options.push({
          value: mic.deviceId,
          label: name ? t('mic.communicationsDefaultWithDevice', { name }) : t('mic.communicationsDefault'),
          title: mic.label || undefined,
        })
        continue
      }
      options.push({
        value: mic.deviceId,
        label: cleanMicLabel(mic.label) || t('mic.unnamed', { id: mic.deviceId.slice(0, 8) }),
        title: mic.label || undefined,
      })
    }
    if (selectedMic && selectedMic !== 'default' && !visible.has(selectedMic)) {
      options.push({ value: selectedMic, label: t('mic.savedNotListed') })
    }
    return options
  }, [mics, selectedMic, t])

  const boostOptions = useMemo(() => [
    { value: '1', label: t('mic.boostOff') },
    { value: '2', label: t('mic.boost2x') },
    { value: '3', label: t('mic.boost3x') },
    { value: '5', label: t('mic.boost5x') },
    { value: 'auto', label: t('mic.boostAuto') },
  ] as const, [t])

  const vol = VOLUME_CONFIG[volumeLevel]

  return (
    <Card>
      <CardContent className="p-6">
        <h2 className="mb-4 text-lg font-semibold">{t('mic.title')}</h2>
        <div className="space-y-4">
          <div>
            <label id="mic-select-label" className="mb-2 block text-sm text-foreground">{t('mic.select')}</label>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Select
                value={selectedMic}
                onChange={onMicChange}
                options={micOptions}
                labelledBy="mic-select-label"
                className="sm:flex-1"
              />
              <Button variant="outline" size="sm" onClick={onTestMic} disabled={testing} className="h-9 shrink-0 px-4">
                {testing ? t('mic.testing') : t('mic.test')}
              </Button>
            </div>
          </div>

          {testing && (
            <div className="space-y-2">
              <canvas
                ref={onCanvasRef}
                width={160}
                height={40}
                className="mx-auto rounded-md border border-border"
                style={{ width: '160px', height: '40px' }}
              />
              {volumeLevel !== 'idle' && (
                <div className="text-center">
                  <span className={`text-xs font-medium ${vol.color}`}>{vol.labelKey ? t(vol.labelKey) : ''}</span>
                  <p className="mt-0.5 text-xs text-muted-foreground">{vol.descKey ? t(vol.descKey) : ''}</p>
                </div>
              )}
            </div>
          )}

          {errorMessage && !testing && (
            <p className="text-xs text-destructive">{errorMessage}</p>
          )}

          <div className="flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p id="mic-boost-label" className="text-sm font-medium">{t('mic.boost')}</p>
              <p className="text-xs text-muted-foreground">{t('mic.boostDesc')}</p>
            </div>
            <div className="shrink-0" style={ready ? undefined : { visibility: 'hidden' }}>
              <Segmented
                labelledBy="mic-boost-label"
                value={micBoost}
                onChange={onMicBoostChange}
                options={boostOptions}
                animated={animate}
                size="sm"
                className="shrink-0"
              />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
