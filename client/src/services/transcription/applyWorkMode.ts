import { t } from '@/i18n'
import { refreshRecorderSettings, reconnectProvider } from '@/services/recorder'
import { setSetting } from '@/services/store'
import { systemAudioSession } from '@/services/systemAudio'
import { refreshModeStatus } from '@/stores/modeStatus'
import { switchProvider, type WorkMode } from './index'

/**
 * Service part of a work-mode change: stop subtitles, persist the mode, swap the provider,
 * and refresh the recorder and status badge. UI state stays with the caller.
 */
export async function applyWorkMode(mode: WorkMode): Promise<void> {
  await systemAudioSession.stop()
  const snapshot = systemAudioSession.getSnapshot()
  if (snapshot.state !== 'idle') {
    throw new Error(snapshot.error || t('systemAudio.cleanupFailed'))
  }

  await setSetting('workMode', mode)
  await switchProvider(mode)
  await refreshRecorderSettings()
  reconnectProvider()
  void refreshModeStatus()
}
