import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, within } from 'storybook/test'
import { setAiEnabled } from '@/stores/aiEnabled'
import HotwordPromptInjectToggle from './HotwordPromptInjectToggle'

const aiCleanup = (enabled: boolean) => async () => {
  await setAiEnabled(enabled)
}

const meta = {
  title: 'settings/HotwordPromptInjectToggle',
  component: HotwordPromptInjectToggle,
  parameters: { tauri: { commands: { set_tray_ai_enabled: () => null } } },
  beforeEach: aiCleanup(true),
} satisfies Meta<typeof HotwordPromptInjectToggle>

export default meta
type Story = StoryObj<typeof meta>

export const Enabled: Story = {
  parameters: {
    tauri: { settings: { injectHotwordsToPrompt: true } },
  },
}

export const Disabled: Story = {
  parameters: {
    tauri: { settings: { injectHotwordsToPrompt: false } },
  },
}

export const AiCleanupOff: Story = {
  parameters: {
    tauri: { settings: { injectHotwordsToPrompt: true } },
  },
  beforeEach: aiCleanup(false),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const toggle = await canvas.findByRole('switch', { name: /send hotwords to the ai prompt/i })
    // The saved choice stays visible; only applying it is blocked.
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect(toggle).toBeDisabled()
    await expect(canvas.getByText(/hotwords aren't added to the ai prompt/i)).toBeVisible()
  },
}
