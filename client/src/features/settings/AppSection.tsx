import { Card, CardContent } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { useT } from '@/i18n/useT'

/**
 * The "check for updates" toggle used to live here. It was removed because updates are now
 * mandatory: they download silently in the background and install when the user opens the
 * update indicator or closes the app. The underlying autoCheckUpdate setting is still read by
 * features/update/autoUpdate.ts, but is no longer exposed as a user control and remains a remote
 * kill switch if the update pipeline itself fails.
 */
export default function AppSection({
  autoLaunch,
  onToggleAutoLaunch,
  ready = true,
  animate = true,
}: {
  autoLaunch: boolean
  onToggleAutoLaunch: () => void
  ready?: boolean
  animate?: boolean
}) {
  const t = useT()
  return (
    <Card>
      <CardContent className="p-6">
        <h2 className="mb-4 text-lg font-semibold">{t('settings.app.title')}</h2>
        <div className="flex items-center justify-between">
          <div>
            <p id="auto-launch-label" className="text-sm font-medium">{t('settings.app.autoLaunch')}</p>
            <p className="text-xs text-muted-foreground">{t('settings.app.autoLaunchDesc')}</p>
          </div>
          <Switch labelledBy="auto-launch-label" checked={autoLaunch} onChange={onToggleAutoLaunch} noAnimation={!animate} hidden={!ready} />
        </div>
      </CardContent>
    </Card>
  )
}
