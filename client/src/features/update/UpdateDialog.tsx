/**
 * Installing overlay.
 *
 * It shows only during the 'installing' phase — at that point the app is about to
 * exit and be replaced by the installer, so the user must be told "don't touch it"
 * and blocking the UI is justified.
 *
 * There is deliberately NO overlay during download: downloads happen only after the
 * user pressed "Download and install", and the About page already shows progress.
 * The old implementation also covered the screen during automatic background
 * downloads, with no close button, which startled users mid-dictation.
 */

import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { onAutoUpdateChange, getAutoUpdateState, type AutoUpdateState } from './autoUpdate'
import { useT } from '@/i18n/useT'

export default function UpdateDialog() {
  const t = useT()
  const [state, setState] = useState<AutoUpdateState>(getAutoUpdateState)

  useEffect(() => {
    return onAutoUpdateChange(setState)
  }, [])

  if (state.phase !== 'installing') return null

  // The target version comes from the validated metadata the install is acting on.
  const version = state.versionInfo?.latestVersion || ''

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-xl">
        <div className="flex flex-col items-center text-center">
          {/* Theme success token instead of a hardcoded emerald-500: it is the same
              green as the update badge in the bottom-left corner, and it gets a
              suitable lightness in both light and dark themes (a hardcoded emerald
              looks muddy on the dark theme). */}
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-success/10">
            <RefreshCw className="h-7 w-7 animate-spin text-success" />
          </div>
          <h3 className="text-lg font-semibold">{t('update.installingTitle', { version })}</h3>
          <p className="mt-2 text-sm text-muted-foreground">{t('update.installingDesc')}</p>
          <p className="mt-3 text-xs text-muted-foreground/60">{t('update.doNotClose')}</p>
        </div>
      </div>
    </div>
  )
}
