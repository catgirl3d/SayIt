import type { Meta, StoryObj } from '@storybook/react-vite'
import SpeechLanguageSelect from './SpeechLanguageSelect'

const meta = {
  title: 'components/SpeechLanguageSelect',
  component: SpeechLanguageSelect,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof SpeechLanguageSelect>

export default meta
type Story = StoryObj<typeof meta>

export const Automatic: Story = {
  args: {
    value: 'auto',
    onChange: () => undefined,
  },
}

export const Chinese: Story = {
  args: {
    value: 'zh',
    onChange: () => undefined,
  },
}

export const Disabled: Story = {
  args: {
    value: 'en',
    onChange: () => undefined,
    disabled: true,
  },
}
