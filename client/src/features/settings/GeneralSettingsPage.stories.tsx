import type { Meta, StoryObj } from '@storybook/react-vite'
import GeneralSettingsPage from './GeneralSettingsPage'
import { CONTEXT_SELECTION_EDIT_PROMPT } from '@/services/contextAware'

const meta = {
  title: 'settings/GeneralSettingsPage',
  component: GeneralSettingsPage,
  parameters: {
    tauri: {
      commands: {
        get_auto_launch: () => true,
      },
      settings: {
        'ui.language': 'en',
        protectClipboard: false,
        contextAwareWritingEnabled: true,
        historyEnabled: true,
        suppressLateFinalInsertion: true,
        audioRetentionEnabled: true,
        audioRetentionDays: 30,
        logRetentionDays: 15,
        autoCheckUpdate: false,
        contextSelectionEditPrompt: CONTEXT_SELECTION_EDIT_PROMPT,
        'webdav.enabled': true,
        'webdav.url': 'https://dav.jianguoyun.com/dav/SayIt',
        'webdav.username': 'storybook@example.com',
        'webdav.password': 'storybook-app-password',
        'webdav.includeHistory': true,
        'webdav.includeAudio': true,
        'webdav.intervalHours': 72,
        'webdav.keepCount': 10,
        'webdav.lastResult': {
          at: Date.now() - 24 * 60 * 60 * 1000,
          ok: true,
          fileName: 'sayit-2026-10-16.zip',
          bytes: 1024 * 1024,
          includeHistory: true,
          includeAudio: true,
          error: null,
        },
      },
    },
  },
} satisfies Meta<typeof GeneralSettingsPage>

export default meta
type Story = StoryObj<typeof meta>

export const Configured: Story = {}
