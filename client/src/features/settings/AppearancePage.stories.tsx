import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import en from '@/i18n/locales/en.json'
import { getTauriJournal } from '@/storybook/tauriMock'
import AppearancePage from './AppearancePage'

const TOO_DARK_HINT = en['appearance.wave.brightened']

/** True when the page wrote `value` under `key` through the store_set command; the journal records the invoke arguments. */
function storeSetCalled(key: string, value: unknown): boolean {
  return getTauriJournal().calls.some(({ command, args }) => {
    if (command !== 'store_set' || typeof args !== 'object' || args === null || !('key' in args)) return false
    return args.key === key && args.value === value
  })
}

const meta = {
  title: 'settings/AppearancePage',
  component: AppearancePage,
  parameters: {
    tauri: {
      settings: {
        overlayShowDuration: true,
        streamingDisplayEnabled: true,
        overlayWaveTheme: 'black-blue',
        overlayWidth: 'long',
        'ui.animations': true,
      },
    },
  },
} satisfies Meta<typeof AppearancePage>

export default meta
type Story = StoryObj<typeof meta>

export const Configured: Story = {}

export const ToggleAnimations: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const toggle = await canvas.findByRole('switch', { name: 'Interface animations' })

    try {
      await expect(toggle).toHaveAttribute('aria-checked', 'true')

      await userEvent.click(toggle)

      await expect(toggle).toHaveAttribute('aria-checked', 'false')
      await expect(document.documentElement.dataset.motion).toBe('off')
      await waitFor(() => expect(storeSetCalled('ui.animations', false)).toBe(true))

      await userEvent.click(toggle)

      await expect(toggle).toHaveAttribute('aria-checked', 'true')
      await expect(document.documentElement.dataset.motion).not.toBe('off')
      await waitFor(() => expect(storeSetCalled('ui.animations', true)).toBe(true))
    } finally {
      // The smoke suite runs stories in one document; never leave motion off for the next one.
      document.documentElement.dataset.motion = 'on'
    }
  },
}

export const CustomWave: Story = {
  parameters: {
    tauri: {
      settings: {
        overlayShowDuration: true,
        streamingDisplayEnabled: true,
        overlayWaveTheme: 'custom',
        overlayWaveCustom: { mode: 'solid', from: '#34d399', to: '#000000' },
        overlayWidth: 'long',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // The saved theme is read asynchronously; the custom card and its editor appear once it is applied.
    await expect(await canvas.findByRole('button', { name: 'Custom' })).toHaveAttribute('aria-pressed', 'true')
    // Seeded as solid, which is not the default mode (gradient), so the Solid radio is the checked one.
    await expect(canvas.getByRole('radio', { name: 'Solid' })).toHaveAttribute('aria-checked', 'true')
    await expect(canvas.getByRole('radio', { name: 'Gradient' })).toHaveAttribute('aria-checked', 'false')
    await expect(canvas.getByRole('button', { name: '#34D399' })).toHaveAttribute('aria-pressed', 'true')
    // Solid mode draws only the start color, so the dark end must not trigger the too-dark hint.
    await expect(canvas.queryByText(TOO_DARK_HINT)).toBeNull()
  },
}

export const CustomWaveFromBuiltIn: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // Inherits overlayWaveTheme 'black-blue' from the meta settings: no custom editor is shown yet.
    await expect(await canvas.findByRole('button', { name: 'Blue on black' })).toHaveAttribute('aria-pressed', 'true')
    await expect(canvas.queryByRole('radio', { name: 'Solid' })).toBeNull()

    await userEvent.click(canvas.getByRole('button', { name: 'Custom' }))

    await expect(canvas.getByRole('button', { name: 'Custom' })).toHaveAttribute('aria-pressed', 'true')
    // The custom colors were never saved, so the editor starts from DEFAULT_CUSTOM_WAVE, which is a gradient.
    await expect(await canvas.findByRole('radio', { name: 'Gradient' })).toHaveAttribute('aria-checked', 'true')
    await expect(canvas.getByRole('group', { name: 'Presets' })).toBeVisible()
    await expect(canvas.getByRole('button', { name: '#A78BFA → #F472B6' })).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(storeSetCalled('overlayWaveTheme', 'custom')).toBe(true))
  },
}
