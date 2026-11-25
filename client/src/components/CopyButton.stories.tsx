import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { t } from '@/i18n'
import CopyButton from './CopyButton'

const meta = {
  title: 'components/CopyButton',
  component: CopyButton,
  parameters: {
    layout: 'centered',
    tauri: {
      commands: {
        copy_text: () => undefined,
      },
    },
  },
} satisfies Meta<typeof CopyButton>

export default meta
type Story = StoryObj<typeof meta>

export const Transcript: Story = {
  args: {
    text: 'Please review the release notes before tomorrow afternoon.',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const button = canvas.getByRole('button', { name: t('record.copy') })
    await expect(canvasElement.querySelector('.success-check')).toBeNull()

    await userEvent.click(button)

    // The copy runs through the async bridge, so the success icon appears after the click resolves.
    await waitFor(() => expect(canvasElement.querySelector('.success-check')).not.toBeNull())
    await expect(canvasElement.querySelector('.lucide-copy')).toBeNull()

    // The check is mount-only for its animation: after the reset the copy icon is mounted again,
    // and the next success mounts a fresh check.
    await waitFor(() => expect(canvasElement.querySelector('.success-check')).toBeNull(), { timeout: 3000 })
    await expect(canvasElement.querySelector('.lucide-copy')).not.toBeNull()

    await userEvent.click(button)
    await waitFor(() => expect(canvasElement.querySelector('.success-check')).not.toBeNull())
  },
}

export const MultilineTranscript: Story = {
  args: {
    text: 'First, check the recording settings.\n\nThen, run one short dictation and verify the result.',
  },
}
