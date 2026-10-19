import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, userEvent, within } from 'storybook/test'
import { Select } from './select'

const meta = {
  title: 'ui/select',
  component: Select,
  args: {
    value: '',
    onChange: () => undefined,
  },
  parameters: {
    layout: 'centered',
  },
} satisfies Meta<typeof Select>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <div className="w-72 space-y-2">
      <label id="model-label" className="block text-sm font-medium">Recognition model</label>
      <Select
        labelledBy="model-label"
        value="balanced"
        options={[
          { value: 'fast', label: 'Fast model' },
          { value: 'balanced', label: 'Balanced model' },
          { value: 'accurate', label: 'Accurate model' },
        ]}
        onChange={() => undefined}
      />
    </div>
  ),
}

export const Grouped: Story = {
  render: () => (
    <div className="w-72 space-y-2">
      <label id="grouped-provider-label" className="block text-sm font-medium">Provider</label>
      <Select
        labelledBy="grouped-provider-label"
        value="deepgram"
        options={[
          { value: 'deepgram', label: 'Deepgram', group: 'Global' },
          { value: 'groq', label: 'Groq Whisper', group: 'Global' },
          { value: 'doubao', label: 'Doubao ASR', group: 'China' },
          { value: 'qwen', label: 'Qwen ASR', group: 'China' },
          { value: 'custom', label: 'OpenAI-compatible ASR', group: 'Custom endpoint' },
        ]}
        onChange={() => undefined}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Provider' }))

    for (const heading of ['Global', 'China', 'Custom endpoint']) {
      await expect(await body.findByText(heading)).toBeVisible()
    }
    await userEvent.click(body.getByRole('button', { name: 'Qwen ASR' }))
    await expect(within(canvasElement).getByRole('button', { name: 'Provider' })).toHaveTextContent('Deepgram')
  },
}

function SecondaryLabelDemo() {
  const [value, setValue] = useState('deepgram')
  return (
    <div className="w-72 space-y-2">
      <label id="secondary-provider-label" className="block text-sm font-medium">Provider</label>
      <Select
        labelledBy="secondary-provider-label"
        value={value}
        options={[
          { value: 'deepgram', label: 'Deepgram', secondary: 'nova-3' },
          { value: 'openai', label: 'OpenAI', secondary: 'gpt-transcribe' },
          { value: 'custom', label: 'OpenAI-compatible ASR' },
        ]}
        onChange={setValue}
      />
    </div>
  )
}

export const SecondaryLabel: Story = {
  render: () => <SecondaryLabelDemo />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)

    // The plain "label · secondary" text stays in the trigger for assistive tech...
    const trigger = canvas.getByRole('button', { name: 'Provider' })
    await expect(trigger).toHaveTextContent('Deepgram · nova-3')

    await userEvent.click(trigger)
    // ...while the list draws the model behind a decorative vertical rule, not a text dot.
    const option = await body.findByRole('button', { name: 'OpenAI · gpt-transcribe' })
    await expect(option.querySelector('span[aria-hidden="true"]')).not.toBeNull()
    await userEvent.click(option)
    await expect(trigger).toHaveTextContent('OpenAI · gpt-transcribe')
  },
}

export const Placeholder: Story = {
  render: () => (
    <div className="w-72 space-y-2">
      <label id="profile-label" className="block text-sm font-medium">Cloud profile</label>
      <Select
        labelledBy="profile-label"
        value=""
        placeholder="Select a profile"
        options={[
          { value: 'primary', label: 'Primary profile' },
          { value: 'backup', label: 'Backup profile' },
        ]}
        onChange={() => undefined}
      />
    </div>
  ),
}

export const Disabled: Story = {
  render: () => (
    <div className="w-72 space-y-2">
      <label id="disabled-select-label" className="block text-sm font-medium">Recognition model</label>
      <Select
        labelledBy="disabled-select-label"
        value="balanced"
        disabled
        options={[{ value: 'balanced', label: 'Balanced model' }]}
        onChange={() => undefined}
      />
    </div>
  ),
}

export const LongLabel: Story = {
  render: () => (
    <div className="w-72 space-y-2">
      <label id="long-model-label" className="block text-sm font-medium">Recognition model</label>
      <Select
        labelledBy="long-model-label"
        value="large-v3-turbo"
        options={[
          {
            value: 'large-v3-turbo',
            label: 'Whisper large-v3-turbo Q4_K_M for multilingual transcription',
            title: 'Whisper large-v3-turbo Q4_K_M for multilingual transcription',
          },
          { value: 'small', label: 'Whisper small' },
        ]}
        onChange={() => undefined}
      />
    </div>
  ),
}
