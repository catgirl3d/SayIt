import { useEffect, useState } from 'react'
import { open as openFolderDialog } from '@tauri-apps/plugin-dialog'
import { FolderOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { Switch } from '@/components/ui/switch'
import { useT } from '@/i18n/useT'
import * as bridge from '@/services/bridge'
import { addRuntimeEvent } from '@/services/debugLog'
import { getSetting, setSetting } from '@/services/store'
import SettingsRow from './SettingsRow'

interface SubtitleSavingSettingsProps {
  /** A subtitle session is running. The journal is opened when a session starts, so its settings stay read-only meanwhile. */
  active: boolean
  /** Another page action is in flight; the settings stay read-only until it settles. */
  pending: boolean
  /** Called with true and false around a settings write, so the page can hold its other actions until it settles. */
  onPendingChange: (pending: boolean) => void
}

/**
 * The "Saving subtitles" row of the Computer subtitles page and the dialog behind it. It owns every
 * saved value it shows: the session reads them from the store when it starts, not from page state.
 */
export default function SubtitleSavingSettings({ active, pending, onPendingChange }: SubtitleSavingSettingsProps) {
  const t = useT()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [ready, setReady] = useState(false)
  const [dir, setDir] = useState('')
  const [dirDisplay, setDirDisplay] = useState('')
  const [error, setError] = useState('')
  const locked = !ready || active || pending

  useEffect(() => {
    let disposed = false
    // Both values load before the controls unlock: a missing folder would make "Open folder" open the
    // default folder instead of the configured one.
    void Promise.all([
      getSetting<boolean>('systemAudio.transcriptEnabled', false),
      getSetting<string>('systemAudio.transcriptDir', ''),
    ]).then(async ([savedEnabled, savedDir]) => {
      if (disposed) return
      setEnabled(savedEnabled)
      setDir(savedDir)
      setReady(true)
      try {
        // Display only: a failed resolution must not lock the settings.
        const resolved = await bridge.resolveSubtitleTranscriptDir(savedDir)
        if (!disposed) setDirDisplay(resolved)
      } catch (resolveError: unknown) {
        addRuntimeEvent('warn', 'system-audio', 'Could not resolve the transcript folder for display', { error: String(resolveError) })
      }
    }).catch((loadError: unknown) => {
      addRuntimeEvent('warn', 'system-audio', 'Could not load the subtitle saving settings', { error: String(loadError) })
      if (!disposed) setError(t('systemAudio.transcriptLoadFailed'))
    })
    return () => { disposed = true }
  }, [])

  const toggleEnabled = () => {
    if (locked) return
    const next = !enabled
    onPendingChange(true)
    void setSetting('systemAudio.transcriptEnabled', next).then(() => {
      setEnabled(next)
      setError('')
    }).catch(() => {
      setError(t('systemAudio.transcriptSettingFailed'))
    }).finally(() => { onPendingChange(false) })
  }

  const chooseFolder = async () => {
    setError('')
    try {
      const picked = await openFolderDialog({ directory: true, multiple: false, defaultPath: dirDisplay || undefined })
      if (typeof picked !== 'string') return
      await setSetting('systemAudio.transcriptDir', picked)
      setDir(picked)
      setDirDisplay(await bridge.resolveSubtitleTranscriptDir(picked))
    } catch { setError(t('systemAudio.transcriptChooseFailed')) }
  }

  const openFolder = async () => {
    setError('')
    try {
      await bridge.openSubtitleTranscriptFolder(dir)
    } catch { setError(t('systemAudio.transcriptFolderFailed')) }
  }

  // One line that matches what will run. The folder is resolved asynchronously; until it is known the
  // row only says the journal is on. Empty until the saved values have loaded, so a row never
  // advertises a default that the stored setting is about to replace.
  const summary = !ready
    ? ''
    : !enabled
      ? t('systemAudio.summaryOff')
      : dirDisplay
        ? t('systemAudio.summarySavingTo', { folder: dirDisplay })
        : t('systemAudio.summaryOn')

  return (
    <>
      <div>
        <SettingsRow
          icon={FolderOpen}
          title={t('systemAudio.savingRow')}
          summary={summary}
          configureLabel={t('systemAudio.configureSaving')}
          locked={active}
          onConfigure={() => setDialogOpen(true)}
        />
        {/* Shown under the row as well as in the dialog: with the dialog closed this is the only place a load failure can appear. */}
        {error && <p role="alert" className="px-6 pb-4 text-sm leading-6 text-destructive">{error}</p>}
      </div>
      {dialogOpen && (
        <Modal title={t('systemAudio.savingRow')} onClose={() => setDialogOpen(false)} showCloseButton panelClassName="w-[520px]">
          <div className="mt-4 space-y-6">
            <div className="space-y-1">
              <Switch
                checked={enabled}
                onChange={toggleEnabled}
                label={t('systemAudio.transcriptLabel')}
                disabled={locked}
              />
              <p className="text-xs text-muted-foreground">{t('systemAudio.transcriptHelp')}</p>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <span className="text-xs text-muted-foreground">{t('systemAudio.transcriptFolderLabel')}:</span>
                <span className="min-w-0 flex-1 truncate text-xs" title={dirDisplay}>{dirDisplay}</span>
                <Button variant="outline" size="sm" disabled={locked} onClick={() => void chooseFolder()}>
                  {t('systemAudio.transcriptChoose')}
                </Button>
                <Button variant="outline" size="sm" disabled={locked} onClick={() => void openFolder()}>
                  {t('systemAudio.transcriptOpen')}
                </Button>
              </div>
            </div>
            {/* The row's copy is behind the dimmed backdrop and hidden from assistive technology while the dialog is open. */}
            {error && <p role="alert" className="text-sm leading-6 text-destructive">{error}</p>}
          </div>
        </Modal>
      )}
    </>
  )
}
