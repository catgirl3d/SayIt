import type { Meta, StoryObj } from '@storybook/react-vite'
import { ModelLanguageBadge } from './ModelLanguageBadge'

const meta = {
  title: 'settings/ModelLanguageBadge',
  component: ModelLanguageBadge,
} satisfies Meta<typeof ModelLanguageBadge>

export default meta
type Story = StoryObj<typeof meta>

export const SupportsCurrentLanguage: Story = {
  args: {
    model: {
      id: 'nemotron-asr-streaming-0.6b-gguf',
      name: 'Nemotron ASR Streaming',
      languages: ['en', 'uk', 'ru', 'zh'],
    },
    badgeLanguage: 'uk',
  },
}

export const FallsBackForCurrentLanguage: Story = {
  args: {
    model: {
      id: 'sensevoice-small-gguf',
      name: 'SenseVoice Small',
      languages: ['en', 'zh'],
    },
    badgeLanguage: 'uk',
  },
}

export const CatalogWithoutLanguageTags: Story = {
  args: {
    model: {
      id: 'legacy-model',
      name: 'Legacy model',
      languages_label: 'English, Ukrainian',
    },
    badgeLanguage: 'en',
  },
}
