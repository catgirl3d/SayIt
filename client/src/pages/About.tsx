import { useEffect, useMemo, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Github, Loader2, CheckCircle } from 'lucide-react'
import { open as shellOpen } from '@tauri-apps/plugin-shell'
import {
  getAutoUpdateState,
  onAutoUpdateChange,
  checkForUpdateNow,
  downloadAndInstallUpdate,
  hasAvailableUpdate,
  type AutoUpdateState,
} from '@/features/update/autoUpdate'
import {
  getReleaseNotesHistory,
  pinReleaseNotesVersion,
  resolveShownVersion,
  type PinnedReleaseNotesVersion,
} from '@/features/update/changelogHistory'
import { pickReleaseNotes } from '@/features/update/releaseNotes'
import { ReleaseNotesSection } from '@/features/update/ReleaseNotesSection'
import appIconOnDark from '@/assets/icon-128.png'
import appIconOnLight from '@/assets/icon-128-on-light.png'
import { getLocale, t } from '@/i18n'
import { useLocale, useT } from '@/i18n/useT'
import { PROJECT_RELEASES_URL, PROJECT_REPOSITORY_URL } from '@/services/projectLinks'

const currentVersion = __APP_VERSION__

function formatTimestamp(value: number | null | undefined) {
  if (!value) return t('about.neverChecked')
  // Keep date and time formatting aligned with the active UI locale.
  return new Date(value).toLocaleString(getLocale(), { hour12: false })
}

export default function About() {
  const t = useT()
  const [state, setState] = useState<AutoUpdateState>(getAutoUpdateState)
  const [picked, setPicked] = useState<PinnedReleaseNotesVersion | null>(null)

  useEffect(() => {
    return onAutoUpdateChange(setState)
  }, [])

  const { phase, versionInfo, checkedAt, error } = state
  const checking = phase === 'checking'
  const downloading = phase === 'downloading'
  const installing = phase === 'installing'
  // Availability is metadata-only: the version is known from the manifest, but
  // nothing has been downloaded yet. The install button appears whenever a newer
  // version is available and no download/install is already running — do not gate it
  // on `phase === someValue`, which is exactly the shape that used to get stuck.
  const hasUpdate = hasAvailableUpdate(state)
  const canInstall = hasUpdate && !downloading && !installing

  // Release notes history: the bundled changelogs supply every released version, so the
  // page keeps working offline. The manifest can override or add the notes of its exact
  // version; it is display-only here and never changes what the updater offers. Manifest
  // notes arrive localized by the caller, with the English section as the fallback.
  const locale = useLocale()
  const latestVersion = versionInfo?.latestVersion ?? null
  const baseNotes = versionInfo?.notes ?? null
  const localizedNotes = versionInfo?.notesLocalized ?? null
  const manifestNotes = useMemo(
    () => pickReleaseNotes(baseNotes, localizedNotes, locale),
    [baseNotes, localizedNotes, locale],
  )
  const releaseDate = versionInfo?.releaseDate ?? null
  const versionHistory = useMemo(
    () =>
      getReleaseNotesHistory(
        locale,
        latestVersion === null ? null : { version: latestVersion, notes: manifestNotes, releaseDate },
      ),
    [locale, latestVersion, manifestNotes, releaseDate],
  )

  const displayedHistory = useMemo(
    () => pinReleaseNotesVersion(versionHistory, picked, locale),
    [versionHistory, picked, locale],
  )

  // The shown version is derived, not stored: an offline first render starts at the
  // installed version when its bundled section exists, otherwise the newest bundled
  // version. A manifest arriving later moves the default only while nothing is pinned.
  // A stale pick falls back, and an explicit pick survives a manifest refresh or a
  // failed check for the rest of the About session (but not a locale change when the
  // live entry is gone).
  const shownVersion = resolveShownVersion(
    picked?.version ?? null,
    latestVersion,
    currentVersion,
    displayedHistory,
  )

  const handlePickedVersion = (version: string) => {
    const entry = versionHistory.find((candidate) => candidate.version === version)
    if (!entry) return
    setPicked({ ...entry, locale })
  }

  const updateStatusText = (() => {
    if (installing) return t('about.installing')
    if (checking) return t('about.checking')
    if (!versionInfo) return null
    if (versionInfo.error) return t('about.checkFailed')
    if (downloading)
      return t('about.downloading', {
        version: String(versionInfo.latestVersion),
        percent: Math.round(state.downloadPercent ?? 0),
      })
    if (hasUpdate) return t('about.updateAvailable', { version: String(versionInfo.latestVersion) })
    return t('about.upToDate')
  })()

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-4 text-2xl font-bold">{t('about.title')}</h1>

      <Card>
        <CardContent className="p-6">
          {/* Brand */}
          <div className="flex items-center gap-4">
            <img src={appIconOnLight} alt="SayIt" className="block h-16 w-16 rounded-2xl dark:hidden" />
            <img src={appIconOnDark} alt="SayIt" className="hidden h-16 w-16 rounded-2xl dark:block" />
            <div>
              <h2
                className="text-2xl font-bold tracking-tight"
                style={{ fontFamily: "'Nunito', sans-serif", fontWeight: 800 }}
              >
                SayIt
              </h2>
              <p className="text-sm text-muted-foreground">{t('about.tagline')}</p>
              <div className="mt-1.5 flex items-center gap-2">
                {/* The version number is the same pill-button style as the GitHub icon
                    next to it: clicking it opens the releases page, which is exactly
                    where someone looking for history or per-release notes heads first. */}
                <button
                  type="button"
                  onClick={() => void shellOpen(PROJECT_RELEASES_URL)}
                  className="flex h-6 items-center rounded-full bg-muted/50 px-2.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/15 hover:text-foreground"
                  title={t('about.viewReleases')}
                  aria-label={t('about.viewReleases')}
                >
                  v{currentVersion}
                </button>
                <button
                  type="button"
                  onClick={() => void shellOpen(PROJECT_REPOSITORY_URL)}
                  className="flex h-6 w-6 items-center justify-center rounded-full bg-muted/50 text-muted-foreground transition-colors hover:bg-foreground/15 hover:text-foreground"
                  title="GitHub"
                  aria-label="GitHub"
                >
                  <Github className="h-3.5 w-3.5" aria-hidden />
                </button>
                {/* Fork builds must be distinguishable at a glance: an install whose
                    updates come from the fork's releases should never look identical
                    to the upstream app. */}
                <span className="flex h-6 items-center rounded-full bg-muted/50 px-2.5 text-xs text-muted-foreground">
                  {t('about.forkMarker')}
                </span>
              </div>
            </div>
          </div>

          {/* Updates */}
          <div className="mt-5 border-t border-border pt-5">
            <h3 className="mb-3 text-sm font-medium">{t('about.updateSection')}</h3>
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                {updateStatusText && (
                  <p className={`text-sm ${hasUpdate ? 'text-primary font-medium' : 'text-muted-foreground'}`}>
                    {updateStatusText}
                  </p>
                )}
                {error && <p className="text-xs text-red-500">{error}</p>}
                {checkedAt && (
                  <p className="text-xs text-muted-foreground/60">
                    {t('about.lastChecked', { time: formatTimestamp(checkedAt) })}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                {/* One explicit action does everything: download, Rust-side verification,
                    then install + relaunch. There is no separate download step and no
                    install-on-exit fallback — nothing happens unless this is pressed. */}
                {canInstall && (
                  <Button size="sm" onClick={() => void downloadAndInstallUpdate()}>
                    <CheckCircle className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                    {t('about.downloadAndInstall')}
                  </Button>
                )}
                {downloading && (
                  <Button size="sm" disabled>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    {t('about.downloadingShort')}
                  </Button>
                )}
                {installing && (
                  <Button size="sm" disabled>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    {t('about.installingShort')}
                  </Button>
                )}
                {!downloading && !installing && !hasUpdate && (
                  <Button variant="outline" size="sm" onClick={() => void checkForUpdateNow()} disabled={checking}>
                    {checking ? t('about.checkingShort') : t('about.checkUpdate')}
                  </Button>
                )}
              </div>
            </div>
          </div>

          {/* Release notes history */}
          <ReleaseNotesSection
            versions={displayedHistory}
            value={shownVersion ?? ''}
            onChange={handlePickedVersion}
          />
        </CardContent>
      </Card>
    </div>
  )
}
