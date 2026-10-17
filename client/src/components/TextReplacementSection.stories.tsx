import type { Meta, StoryObj } from '@storybook/react-vite'
import TextReplacementSection from './TextReplacementSection'

const meta = {
  title: 'components/TextReplacementSection',
  component: TextReplacementSection,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof TextReplacementSection>

export default meta
type Story = StoryObj<typeof meta>

export const BuiltInFallbackRule: Story = {
  parameters: {
    tauri: {
      settings: {
        textReplacements: [],
      },
    },
  },
}

export const ConfiguredRules: Story = {
  parameters: {
    tauri: {
      settings: {
        textReplacements: [
          { id: 'rule-1', from: 'Cloud Code', to: 'Claude Code', enabled: true },
          { id: 'rule-2', from: 'Say It', to: 'SayIt', enabled: true },
          { id: 'rule-3', from: 'temporary phrase', to: '', enabled: false },
        ],
      },
    },
  },
}
