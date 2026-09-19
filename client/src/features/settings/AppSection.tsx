import { Card, CardContent } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { useT } from '@/i18n/useT'

/**
 * App-level preferences.
 *
 * The "check for updates" toggle controls ONLY the automatic metadata check (a small
 * manifest GET at startup and every six hours). Downloading and installing always
 * require the explicit "Download and install" action on the About page, so this
 * switch can never cause an install — turning it off just means the app stops
 * noticing new releases on its own and the user checks manually.
 */
export default function AppSection({
  autoLaunch,
  onToggleAutoLaunch,
  autoCheckUpdate,
  onToggleAutoCheckUpdate,
  ready = true,
  animate = true,
}: {
  autoLaunch: boolean
  onToggleAutoLaunch: () => void
  autoCheckUpdate: boolean
  onToggleAutoCheckUpdate: () => void
  ready?: boolean
  animate?: boolean
}) {
  const t = useT()
  return (
    <Card>
      <CardContent className="space-y-4 p-6">
        <h2 className="text-lg font-semibold">{t('settings.app.title')}</h2>
        <div className="flex items-center justify-between">
          <div>
            <p id="auto-launch-label" className="text-sm font-medium">{t('settings.app.autoLaunch')}</p>
            <p className="text-xs text-muted-foreground">{t('settings.app.autoLaunchDesc')}</p>
          </div>
          <Switch labelledBy="auto-launch-label" checked={autoLaunch} onChange={onToggleAutoLaunch} noAnimation={!animate} hidden={!ready} />
        </div>
        <div className="flex items-center justify-between border-t border-border pt-4">
          <div>
            <p id="auto-check-update-label" className="text-sm font-medium">{t('settings.app.autoCheckUpdate')}</p>
            <p className="text-xs text-muted-foreground">{t('settings.app.autoCheckUpdateDesc')}</p>
          </div>
          <Switch
            labelledBy="auto-check-update-label"
            checked={autoCheckUpdate}
            onChange={onToggleAutoCheckUpdate}
            noAnimation={!animate}
            hidden={!ready}
          />
        </div>
      </CardContent>
    </Card>
  )
}
