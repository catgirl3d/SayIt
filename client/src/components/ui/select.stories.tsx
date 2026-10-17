import type { Meta, StoryObj } from '@storybook/react-vite'
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
