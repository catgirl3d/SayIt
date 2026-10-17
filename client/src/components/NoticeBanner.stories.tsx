import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { expect, fn, waitFor, within } from 'storybook/test'
import type { Meta, StoryObj } from '@storybook/react-vite'
import NoticeBanner from './NoticeBanner'
import type { RemoteNotice } from '@/services/notice'

const DEV_NOTICE_KEY = '__devNotice'
const serverNoticeStub = fn(() => new Response(
  JSON.stringify({
    id: 'storybook-server-notice',
    level: 'info',
    title: 'Server-provided notice',
    body: 'This notice was loaded through the backend API.',
    minVersion: '0.0.0',
    linkUrl: 'https://sayitapp.site/status',
    linkLabel: 'View service status',
    dismissible: true,
  }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
))

function NoticeFixture({ notice }: { notice: RemoteNotice }) {
  const previousValue = useRef<string | null | undefined>(undefined)

  if (previousValue.current === undefined) {
    previousValue.current = window.localStorage.getItem(DEV_NOTICE_KEY)
    window.localStorage.setItem(DEV_NOTICE_KEY, JSON.stringify(notice))
  }

  useEffect(() => () => {
    const previous = previousValue.current
    if (previous === null || previous === undefined) {
      window.localStorage.removeItem(DEV_NOTICE_KEY)
    } else {
      window.localStorage.setItem(DEV_NOTICE_KEY, previous)
    }
  }, [])

  return <NoticeBanner />
}

function NetworkNoticeFixture() {
  const previousValue = useRef<string | null | undefined>(undefined)
  const [ready, setReady] = useState(false)

  useLayoutEffect(() => {
    previousValue.current = window.localStorage.getItem(DEV_NOTICE_KEY)
    window.localStorage.removeItem(DEV_NOTICE_KEY)
    setReady(true)

    return () => {
      const previous = previousValue.current
      if (previous === null || previous === undefined) {
        window.localStorage.removeItem(DEV_NOTICE_KEY)
      } else {
        window.localStorage.setItem(DEV_NOTICE_KEY, previous)
      }
    }
  }, [])

  return ready ? <NoticeBanner /> : null
}

const meta = {
  title: 'components/NoticeBanner',
  component: NoticeBanner,
  parameters: {
    layout: 'padded',
    tauri: {
      settings: {
        dismissedNoticeIds: [],
      },
    },
  },
} satisfies Meta<typeof NoticeBanner>

export default meta
type Story = StoryObj<typeof meta>

export const WarningWithLink: Story = {
  render: () => (
    <NoticeFixture
      notice={{
        id: 'storybook-maintenance',
        level: 'warning',
        title: 'Scheduled service maintenance',
        body: 'Cloud recognition may be unavailable for a short period.',
        linkUrl: 'https://sayitapp.site/status',
        linkLabel: 'View service status',
      }}
    />
  ),
}

export const PersistentCritical: Story = {
  render: () => (
    <NoticeFixture
      notice={{
        id: 'storybook-critical',
        level: 'critical',
        title: 'Action required',
        body: 'Update the server connection before starting another dictation.',
        dismissible: false,
      }}
    />
  ),
}

export const ServerNotice: Story = {
  render: () => <NetworkNoticeFixture />,
  parameters: {
    tauri: {
      settings: {
        dismissedNoticeIds: [],
      },
    },
    network: {
      'https://sayitapp.site/api/notice': serverNoticeStub,
    },
  },
  beforeEach: () => {
    serverNoticeStub.mockClear()
  },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(serverNoticeStub).toHaveBeenCalledTimes(1))

    const canvas = within(canvasElement)
    await expect(await canvas.findByText('Server-provided notice', { exact: true })).toBeVisible()
    await expect(await canvas.findByText('This notice was loaded through the backend API.', { exact: true })).toBeVisible()
  },
}
