import type { Meta, StoryObj } from '@storybook/react-vite'
import { userEvent, within } from 'storybook/test'
import ServerSection from './ServerSection'

const meta = {
  title: 'settings/ServerSection',
  component: ServerSection,
} satisfies Meta<typeof ServerSection>

export default meta
type Story = StoryObj<typeof meta>

export const Configured: Story = {
  args: { speechLanguage: 'en' },
}

export const UnsavedAddress: Story = {
  args: { speechLanguage: 'uk' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const input = canvas.getByRole('textbox')
    await userEvent.clear(input)
    await userEvent.type(input, 'http://localhost:8000')
  },
}
