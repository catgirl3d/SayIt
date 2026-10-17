import type { Meta, StoryObj } from '@storybook/react-vite'
import type { RemoteNotice } from '@/services/notice'
import type { UsageSummary } from '@/types/usage'
import Home from './Home'

const usageSummary: UsageSummary = {
  takes: 42,
  totalChars: 18_420,
  totalDurationSec: 3_780,
  datedTakes: 42,
  datedChars: 18_420,
  maxDurationSec: 240,
  activeDays: 12,
  hourBuckets: Array.from({ length: 24 }, (_, hour) => (hour >= 9 && hour <= 17 ? 3 : 0)),
  apps: [{ key: 'code.exe', takes: 18, chars: 9_200 }],
  workModes: [{ key: 'local', takes: 30, chars: 12_600 }],
  promptPresets: [{ key: 'intent', takes: 28, chars: 11_400 }],
  firstUsedAt: Date.now() - 14 * 86_400_000,
  lastUsedAt: Date.now() - 15 * 60_000,
}

const serverNotice = {
  id: 'storybook-server-notice',
  level: 'warning',
  title: 'Scheduled service maintenance',
  body: 'Cloud recognition may be unavailable for a short period.',
  linkUrl: 'https://sayitapp.site/status',
  linkLabel: 'View service status',
  minVersion: '0.0.0',
  dismissible: false,
} satisfies RemoteNotice

const meta = {
  title: 'pages/Home',
  component: Home,
  beforeEach: () => {
    const previousNotice = localStorage.getItem('__devNotice')
    localStorage.setItem('__devNotice', JSON.stringify({
      id: 'storybook-home-no-notice',
      level: 'info',
      title: 'Storybook fixture',
      minVersion: '999.0.0',
    }))
    return () => {
      if (previousNotice === null) localStorage.removeItem('__devNotice')
      else localStorage.setItem('__devNotice', previousNotice)
    }
  },
} satisfies Meta<typeof Home>

export default meta
type Story = StoryObj<typeof meta>

export const WithUsage: Story = {
  parameters: {
    tauri: {
      commands: {
        usage_summary: () => usageSummary,
      },
      settings: {
        shortcutHandsFree: 'AltRight',
        shortcutPTT: 'ControlRight',
        dismissedNoticeIds: [],
      },
    },
  },
}

export const ServerNotice: Story = {
  beforeEach: () => {
    localStorage.removeItem('__devNotice')
  },
  parameters: {
    network: {
      'https://sayitapp.site/api/notice': () => new Response(JSON.stringify(serverNotice), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    },
    tauri: {
      commands: {
        usage_summary: () => usageSummary,
      },
      settings: {
        shortcutHandsFree: 'AltRight',
        shortcutPTT: 'ControlRight',
        dismissedNoticeIds: [],
      },
    },
  },
}
