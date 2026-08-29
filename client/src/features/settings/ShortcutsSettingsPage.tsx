import * as bridge from '@/services/bridge'
import { refreshPTTSetting } from '@/services/webviewKeyboardFallback'
import { useState, useEffect, useCallback } from 'react'
import { Info } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Tooltip } from '@/components/ui/tooltip'
import {
  PTTShortcutInput,
  ComboShortcutInput,
} from './ShortcutInputs'
import { pttShortcutConflictsWithAccelerator } from '@/lib/shortcutKeys'
import { getPresetShortcuts, getSetting, setSetting } from '@/services/store'
import { getDefault } from '@/services/defaults'
import { refreshRecorderSettings } from '@/services/recorder'
import { useT } from '@/i18n/useT'

function ShortcutLabel({ label, help }: { label: string; help: string }) {
  const t = useT()
  return (
    <span className="inline-flex items-center gap-1.5">
      <span>{label}</span>
      <Tooltip variant="light" content={help}>
        <Info
          aria-label={t('settings.helpAria', { label })}
          className="h-3.5 w-3.5 shrink-0 cursor-help text-muted-foreground/50 transition-colors hover:text-muted-foreground"
        />
      </Tooltip>
    </span>
  )
}

export default function ShortcutsSettingsPage() {
  const t = useT()
  const [pttKey, setPttKey] = useState(() => getDefault<string>('shortcutPTT', ''))
  const [handsFreeKey, setHandsFreeKey] = useState('AltRight')
  const [aiToggleKey, setAiToggleKey] = useState('')

  useEffect(() => {
    getSetting<string>('shortcutPTT').then((value) => setPttKey(value)).catch(() => { })
    getSetting('shortcutHandsFree', 'AltRight').then((value) => setHandsFreeKey(value as string)).catch(() => { })
    getSetting('shortcutToggleAi', '').then((value) => setAiToggleKey(value as string)).catch(() => { })
  }, [])

  const handlePTTChange = async (key: string) => {
    setPttKey(key)
    await setSetting('shortcutPTT', key)
    await refreshPTTSetting()
    await refreshRecorderSettings()
    bridge.notifyShortcutsChanged()
  }

  const handleHandsFreeChange = async (key: string) => {
    setHandsFreeKey(key)
    await setSetting('shortcutHandsFree', key)
    await refreshPTTSetting()
    await refreshRecorderSettings()
    bridge.notifyShortcutsChanged()
  }

  const validatePTT = useCallback(async (value: string) => {
    if (!value) return null
    if (pttShortcutConflictsWithAccelerator(value, handsFreeKey)) {
      return t('settings.shortcuts.conflictHandsFree')
    }
    if (pttShortcutConflictsWithAccelerator(value, aiToggleKey)) {
      return t('settings.shortcuts.conflictAiToggle')
    }
    const presetShortcuts = await getPresetShortcuts()
    if (Object.values(presetShortcuts).some(
      (shortcut) => pttShortcutConflictsWithAccelerator(value, shortcut),
    )) return t('settings.shortcuts.conflictPreset')
    return null
  }, [handsFreeKey, aiToggleKey, t])

  const validateHandsFree = useCallback(async (value: string) => {
    if (!value) return null
    if (pttShortcutConflictsWithAccelerator(pttKey, value)) {
      return t('settings.shortcuts.conflictPtt')
    }
    if (value === aiToggleKey) return t('settings.shortcuts.conflictAiToggle')
    const presetShortcuts = await getPresetShortcuts()
    if (Object.values(presetShortcuts).includes(value)) return t('settings.shortcuts.conflictPreset')
    return null
  }, [pttKey, aiToggleKey, t])

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-6 text-2xl font-bold">{t('nav.shortcuts')}</h1>
      <div className="space-y-6">
        <Card>
          <CardContent className="p-6">
            <h2 className="text-lg font-semibold">{t('settings.shortcuts.title')}</h2>
            <p className="mb-4 mt-1 text-xs text-muted-foreground">
              {t('settings.shortcuts.escHint')}
            </p>
            <div className="space-y-4">
              <ComboShortcutInput
                value={handsFreeKey}
                onChange={handleHandsFreeChange}
                validate={validateHandsFree}
                label={<ShortcutLabel label={t('settings.shortcuts.handsFree')} help={t('settings.shortcuts.handsFreeHelp')} />}
                description={t('settings.shortcuts.handsFreeDesc')}
              />
              <PTTShortcutInput
                value={pttKey}
                onChange={handlePTTChange}
                validate={validatePTT}
                label={<ShortcutLabel label={t('settings.shortcuts.ptt')} help={t('settings.shortcuts.pttHelp')} />}
                description={t('settings.shortcuts.pttDesc')}
              />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
