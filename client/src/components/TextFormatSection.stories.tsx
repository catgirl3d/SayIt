import type { Meta, StoryObj } from '@storybook/react-vite'
import TextFormatSection from './TextFormatSection'

const meta = {
  title: 'components/TextFormatSection',
  component: TextFormatSection,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof TextFormatSection>

export default meta
type Story = StoryObj<typeof meta>

export const ChineseSpeechFormatting: Story = {
  parameters: {
    tauri: {
      settings: {
        textPostProcess: {
          autoSegment: true,
          normalizeNumbers: false,
          stripTrailingPunctuation: true,
          punctuationToSpace: false,
        },
        'speechInput.language': 'zh',
      },
    },
  },
}

export const EnglishSpeechFormatting: Story = {
  parameters: {
    tauri: {
      settings: {
        textPostProcess: {
          autoSegment: false,
          normalizeNumbers: true,
          stripTrailingPunctuation: false,
          punctuationToSpace: true,
        },
        'speechInput.language': 'en',
      },
    },
  },
}
