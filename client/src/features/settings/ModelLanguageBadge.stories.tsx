import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { t } from '@/i18n'
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

export const PopoverDismissal: Story = {
  args: {
    model: {
      id: 'nemotron-asr-streaming-0.6b-gguf',
      name: 'Nemotron ASR Streaming',
      languages: ['en', 'uk', 'ru', 'zh'],
    },
    badgeLanguage: 'uk',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    const label = t('local.languagesTitle', { count: 4 })
    const trigger = canvas.getByRole('button', { name: label })

    await userEvent.click(trigger)
    const dialog = await body.findByRole('dialog', { name: label })

    // The open effect moves focus into the panel after 50 ms. Without waiting for it the focus check
    // below would pass on the trigger alone, where focus already is right after the click.
    const closeButton = within(dialog).getByRole('button', { name: t('common.close') })
    await waitFor(() => expect(closeButton).toHaveFocus())

    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(body.queryByRole('dialog', { name: label })).toBeNull())
    await expect(trigger).toHaveFocus()

    await userEvent.click(trigger)
    await body.findByRole('dialog', { name: label })

    // The story wrapper is outside both the panel and the trigger.
    await userEvent.click(canvasElement)
    await waitFor(() => expect(body.queryByRole('dialog', { name: label })).toBeNull())
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
