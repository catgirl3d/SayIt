import { fireEvent, waitFor } from '@testing-library/react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import type { WebDavLastResult } from '@/services/webdavBackup'
import WebDavSection from './WebDavSection'

const successfulResult: WebDavLastResult = {
  at: Date.now() - 45 * 60 * 1000,
  ok: true,
  fileName: 'sayit-2026-10-17.zip',
  bytes: 4_850_000,
  includeHistory: true,
  includeAudio: false,
  error: null,
}

const failedResult: WebDavLastResult = {
  at: Date.now() - 20 * 60 * 1000,
  ok: false,
  fileName: '',
  bytes: 0,
  includeHistory: true,
  includeAudio: true,
  error: 'WEBDAV_UNAUTHORIZED',
}

const configuredSettings = {
  'webdav.enabled': true,
  'webdav.url': 'https://dav.example.test/SayIt',
  'webdav.username': 'storybook@example.test',
  'webdav.password': 'app-password',
  'webdav.includeHistory': true,
  'webdav.includeAudio': false,
  'webdav.intervalHours': 168,
  'webdav.keepCount': 10,
  'webdav.lastResult': successfulResult,
  'speechInput.language': 'en',
}

const commands = {
  webdav_test: () => 7,
  webdav_list: () => [
    { name: 'sayit-2026-10-17.zip', size: 4_850_000 },
    { name: 'sayit-2026-10-10.zip', size: 4_620_000 },
  ],
  webdav_backup_now: () => ({
    fileName: 'sayit-2026-10-17.zip',
    bytes: 4_850_000,
    includeHistory: true,
    includeAudio: false,
    finishedAt: Date.now(),
    pruned: 1,
  }),
  webdav_restore: () => undefined,
  restart_app: () => undefined,
  append_debug_log: () => undefined,
}

const meta = {
  title: 'settings/WebDavSection',
  component: WebDavSection,
  parameters: {
    layout: 'padded',
    tauri: { commands, settings: configuredSettings },
  },
} satisfies Meta<typeof WebDavSection>

export default meta
type Story = StoryObj<typeof meta>

export const ConfiguredHealthy: Story = {}

export const ConfiguredWithFailure: Story = {
  parameters: {
    tauri: {
      commands,
      settings: { ...configuredSettings, 'webdav.lastResult': failedResult },
    },
  },
}

export const ConnectionTested: Story = {
  play: async () => {
    const settingsButton = document.body.querySelector('button[aria-label="Settings"]')
    if (!(settingsButton instanceof HTMLButtonElement)) throw new Error('WebDAV settings action is missing')
    fireEvent.click(settingsButton)
    await waitFor(() => {
      if (!document.body.textContent?.includes('Backup settings')) throw new Error('WebDAV settings dialog did not open')
    })

    const testButton = Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent?.includes('Test connection'))
    if (!(testButton instanceof HTMLButtonElement)) throw new Error('WebDAV test action is missing')
    fireEvent.click(testButton)
    await waitFor(() => {
      if (!document.body.textContent?.includes('Connected. 7 backup(s) already there.')) throw new Error('WebDAV test result is missing')
    })
  },
}

export const RemoteBackups: Story = {
  play: async () => {
    const restoreButton = document.body.querySelector('button[aria-label="Restore from server"]')
    if (!(restoreButton instanceof HTMLButtonElement)) throw new Error('WebDAV restore action is missing')
    fireEvent.click(restoreButton)
    await waitFor(() => {
      if (!document.body.textContent?.includes('Pick a backup to restore')) throw new Error('WebDAV restore list did not open')
      if (!document.body.textContent?.includes('sayit-2026-10-17.zip')) throw new Error('WebDAV backup list is empty')
    })
  },
}
