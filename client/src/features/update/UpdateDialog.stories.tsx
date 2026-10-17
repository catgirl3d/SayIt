import { waitFor } from '@testing-library/react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { checkForUpdateNow, downloadAndInstallUpdate } from './autoUpdate'
import UpdateDialog from './UpdateDialog'
import { projectReleaseInstallerUrl } from '@/services/projectLinks'

const updateVersion = '9.9.9'
const updateSha512 = `${'A'.repeat(86)}==`

const manifest = {
  version: updateVersion,
  releaseDate: '2026-10-17T00:00:00.000Z',
  url: projectReleaseInstallerUrl(updateVersion),
  sha512: updateSha512,
  notes: 'Improves diagnostics and keeps the update flow explicit.',
  notesLocalized: { en: 'Improves diagnostics and keeps the update flow explicit.' },
}

let rejectInstall: ((reason?: unknown) => void) | undefined

/**
 * Manifest for the currently installed build: the version matches and the installer URL is
 * rebuilt for it (the checker requires projectReleaseInstallerUrl(version) exactly), so the
 * restore check yields a clean up-to-date state instead of an invalid-manifest error.
 */
const currentReleaseManifest = {
  ...manifest,
  version: __APP_VERSION__,
  url: projectReleaseInstallerUrl(__APP_VERSION__),
}
let manifestOverrideForCurrentRelease = false

const meta = {
  title: 'features/update/UpdateDialog',
  component: UpdateDialog,
  parameters: {
    layout: 'fullscreen',
    tauri: {
      commands: {
        check_update_manifest: () => ({
          status: 200,
          body: manifestOverrideForCurrentRelease ? currentReleaseManifest : manifest,
        }),
        download_update: () => undefined,
        install_downloaded_update: () => new Promise<void>((_resolve, reject) => {
          rejectInstall = reject
        }),
        append_debug_log: () => undefined,
      },
    },
  },
} satisfies Meta<typeof UpdateDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Installing: Story = {
  play: async () => {
    // Replays re-run the play: start from the story update, not from a previous restore.
    manifestOverrideForCurrentRelease = false
    await checkForUpdateNow()
    const install = downloadAndInstallUpdate()

    await waitFor(() => {
      if (!document.body.querySelector('[role="alertdialog"]')) throw new Error('Installing overlay did not appear')
    })

    rejectInstall?.(new Error('storybook install cancelled after rendering'))
    await install

    // Restore the shared autoUpdate singleton: re-check against the currently installed
    // release so later stories (e.g. pages/About) do not render the 9.9.9 story update.
    manifestOverrideForCurrentRelease = true
    const restored = await checkForUpdateNow()
    if (restored?.hasUpdate || restored?.error) {
      throw new Error(`autoUpdate restore failed: ${restored?.error ?? 'update reported as available'}`)
    }
  },
}
