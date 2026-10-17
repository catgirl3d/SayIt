import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Button } from './button'
import { Modal } from './modal'

const meta = {
  title: 'ui/modal',
  component: Modal,
  args: {
    title: 'Portal preview',
    onClose: () => undefined,
    children: null,
  },
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof Modal>

export default meta
type Story = StoryObj<typeof meta>

function ModalExample() {
  const [open, setOpen] = useState(true)
  return (
    <div className="flex min-h-[240px] items-center justify-center p-8">
      <Button onClick={() => setOpen(true)}>Open modal</Button>
      {open && (
        <Modal title="Portal preview" description="This panel is rendered into document.body." onClose={() => setOpen(false)} showCloseButton>
          <p className="text-sm text-muted-foreground">The backdrop and panel inherit the active theme.</p>
        </Modal>
      )}
    </div>
  )
}

export const Light: Story = {
  globals: { theme: 'light', locale: 'en' },
  render: () => <ModalExample />,
}

export const Dark: Story = {
  globals: { theme: 'dark', locale: 'en' },
  render: () => <ModalExample />,
}

export const Claude: Story = {
  globals: { theme: 'claude', locale: 'en' },
  render: () => <ModalExample />,
}
