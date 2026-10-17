import type { Meta, StoryObj } from '@storybook/react-vite'
import SpeechLanguageSection from './SpeechLanguageSection'

const meta = {
  title: 'settings/SpeechLanguageSection',
  component: SpeechLanguageSection,
} satisfies Meta<typeof SpeechLanguageSection>

export default meta
type Story = StoryObj<typeof meta>

export const Automatic: Story = {
  args: { value: 'auto', onChange: () => undefined },
}

export const Ukrainian: Story = {
  args: { value: 'uk', onChange: () => undefined },
}

export const Chinese: Story = {
  args: { value: 'zh', onChange: () => undefined },
}
