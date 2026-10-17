import { fireEvent } from '@testing-library/react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect } from 'storybook/test'
import { getTauriJournal } from '@/storybook/tauriMock'
import LogViewerPanel from './LogViewerPanel'

const logContent = [
  '[2026-10-17T13:42:00.000Z] [ERROR] [recorder] Target application rejected text insertion',
  '[2026-10-17T13:40:00.000Z] [WARN] [update] Update check returned an invalid manifest',
  '[2026-10-17T13:38:00.000Z] [INFO] [recorder] Final result received',
  'A legacy line without structured metadata',
].join('\n')

const meta = {
  title: 'settings/LogViewerPanel',
  component: LogViewerPanel,
  parameters: {
    layout: 'padded',
    tauri: {
      commands: {
        read_log_file: () => logContent,
        open_log_folder: () => undefined,
      },
    },
  },
} satisfies Meta<typeof LogViewerPanel>

export default meta
type Story = StoryObj<typeof meta>

export const Loaded: Story = {}

export const Empty: Story = {
  parameters: {
    tauri: {
      commands: {
        read_log_file: () => null,
        open_log_folder: () => undefined,
      },
    },
  },
}

export const OpenDirectory: Story = {
  play: async () => {
    const button = Array.from(document.body.querySelectorAll('button')).find((candidate) => candidate.textContent?.trim() === 'Open folder')
    if (!(button instanceof HTMLButtonElement)) throw new Error('Log-directory action is missing')
    fireEvent.click(button)
    expect(
      getTauriJournal().calls.some((call) => call.command === 'open_log_folder'),
    ).toBe(true)
  },
}
