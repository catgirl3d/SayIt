import type { Meta, StoryObj } from '@storybook/react-vite'
import { ConfirmDeleteModal } from './ConfirmDeleteModal'

const meta = {
  title: 'settings/ConfirmDeleteModal',
  component: ConfirmDeleteModal,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof ConfirmDeleteModal>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    title: 'Delete this AI preset?',
    body: 'The preset and its shortcut will be removed from this device. This cannot be undone.',
    onCancel: () => undefined,
    onConfirm: () => undefined,
  },
}

export const DangerWithCustomLabel: Story = {
  args: {
    title: 'Remove this provider profile?',
    body: 'The saved endpoint and credentials will be deleted from the local settings store.',
    onCancel: () => undefined,
    onConfirm: () => undefined,
    showCloseButton: true,
    danger: true,
    confirmLabel: 'Remove profile',
  },
}
