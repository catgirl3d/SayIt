import { fireEvent, waitFor } from '@testing-library/react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { Info } from 'lucide-react'
import { HelpSection } from './HelpSection'
import { PageHelp } from './PageHelp'

const meta = {
  title: 'settings/PageHelp',
  component: PageHelp,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof PageHelp>

export default meta
type Story = StoryObj<typeof meta>

export const OpensHelpDialog: Story = {
  args: {
    title: 'Voice engine help',
    children: (
      <>
        <HelpSection title="Local processing" icon={Info}>
          <p>Download a local model when recognition should work without a server connection.</p>
        </HelpSection>
        <HelpSection title="Cloud processing">
          <p>Cloud providers need their own credentials and may expose additional recognition models.</p>
        </HelpSection>
      </>
    ),
  },
  play: async () => {
    const helpButton = Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Help')
    if (!(helpButton instanceof HTMLButtonElement)) throw new Error('Page-help button is missing')
    fireEvent.click(helpButton)
    await waitFor(() => {
      const dialog = document.body.querySelector('[role="dialog"]')
      if (!dialog?.textContent?.includes('Voice engine help')) throw new Error('Page-help dialog did not open')
    })
  },
}
