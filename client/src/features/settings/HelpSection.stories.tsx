import type { Meta, StoryObj } from '@storybook/react-vite'
import { Info } from 'lucide-react'
import { HelpSection } from './HelpSection'

const meta = {
  title: 'settings/HelpSection',
  component: HelpSection,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof HelpSection>

export default meta
type Story = StoryObj<typeof meta>

export const WithIcon: Story = {
  args: {
    title: 'Choose the processing engine',
    icon: Info,
    children: (
      <>
        <p>Local processing keeps audio on this machine and requires a downloaded model.</p>
        <p>The server and cloud options trade local storage for network processing.</p>
      </>
    ),
  },
}

export const WithoutIcon: Story = {
  args: {
    title: 'Cleanup presets',
    children: (
      <>
        <p>Presets control how the recognized transcript is cleaned before insertion.</p>
        <p>Custom presets stay in the local configuration and can be shared through settings export.</p>
      </>
    ),
  },
}
