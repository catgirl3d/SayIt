import { expect, fn, userEvent, waitFor, within } from 'storybook/test'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { setAiEnabled } from '@/stores/aiEnabled'
import TitleBar from './TitleBar'

const windowCommands = {
  minimize: fn(),
  maximize: fn(),
  close: fn(),
}

const meta = {
  title: 'components/TitleBar',
  component: TitleBar,
  parameters: {
    layout: 'fullscreen',
    tauri: {
      commands: {
        set_tray_ai_enabled: () => undefined,
        'plugin:window|minimize': windowCommands.minimize,
        'plugin:window|toggle_maximize': windowCommands.maximize,
        'plugin:window|close': windowCommands.close,
      },
    },
  },
} satisfies Meta<typeof TitleBar>

export default meta
type Story = StoryObj<typeof meta>

function getAiToggleTrack(toggle: HTMLElement) {
  const track = toggle.querySelector('span.relative')
  if (!(track instanceof HTMLElement)) throw new Error('Title bar AI toggle track not found')
  return track
}

export const Default: Story = {}

export const WindowControls: Story = {
  play: async ({ canvasElement }) => {
    windowCommands.minimize.mockClear()
    windowCommands.maximize.mockClear()
    windowCommands.close.mockClear()

    const controls = within(canvasElement).getAllByRole('button')
    if (controls.length !== 3) {
      throw new Error(`Expected three window controls, found ${controls.length}`)
    }

    await userEvent.click(controls[0])
    await waitFor(() => expect(windowCommands.minimize).toHaveBeenCalledWith({ label: 'main' }))

    await userEvent.click(controls[1])
    await waitFor(() => expect(windowCommands.maximize).toHaveBeenCalledWith({ label: 'main' }))

    await userEvent.click(controls[2])
    await waitFor(() => expect(windowCommands.close).toHaveBeenCalledWith({ label: 'main' }))
  },
}

export const AiCleanupOff: Story = {
  globals: { theme: 'dark', locale: 'en' },
  play: async ({ canvasElement }) => {
    try {
      await setAiEnabled(false)
      const canvas = within(canvasElement)
      const toggle = await canvas.findByRole('switch', { name: /ai processing/i, checked: false })
      const track = getAiToggleTrack(toggle)
      await waitFor(() => expect(track).not.toHaveStyle({ visibility: 'hidden' }))
      await expect(toggle).toHaveAttribute('aria-checked', 'false')
      await expect(track).toHaveClass('bg-muted', 'dark:bg-muted-foreground/35')
    } finally {
      await setAiEnabled(false)
    }
  },
}

export const AiCleanupOn: Story = {
  globals: { theme: 'dark', locale: 'en' },
  play: async ({ canvasElement }) => {
    try {
      await setAiEnabled(false)
      const canvas = within(canvasElement)
      const toggle = await canvas.findByRole('switch', { name: /ai processing/i, checked: false })
      const track = getAiToggleTrack(toggle)
      await waitFor(() => expect(track).not.toHaveStyle({ visibility: 'hidden' }))

      await userEvent.click(toggle)
      await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
      await waitFor(() => expect(track).toHaveClass('bg-primary'))
    } finally {
      await setAiEnabled(false)
    }
  },
}
