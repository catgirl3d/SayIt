export const PROJECT_REPOSITORY_URL = 'https://github.com/catgirl3d/SayIt'
export const PROJECT_RELEASES_URL = `${PROJECT_REPOSITORY_URL}/releases`
export const PROJECT_BUG_REPORT_URL = `${PROJECT_REPOSITORY_URL}/issues/new?template=bug-report.yml`

/**
 * Stable manifest URL of the latest fork release. The manifest itself points at the
 * immutable version-tagged installer asset of that same release, so clients can check
 * for updates against one constant URL while still downloading from a frozen asset.
 */
export const PROJECT_UPDATE_MANIFEST_URL = `${PROJECT_RELEASES_URL}/latest/download/latest-win32-x64.json`

/**
 * The only installer URL this machine is allowed to download and run: the fork's own
 * release asset, derived from the manifest version. The update checker requires the
 * manifest's url field to equal exactly this string; the Rust downloader re-derives
 * and re-checks the same rule independently.
 */
export function projectReleaseInstallerUrl(version: string): string {
  return `${PROJECT_RELEASES_URL}/download/v${version}/SayIt_${version}_x64-setup.exe`
}
