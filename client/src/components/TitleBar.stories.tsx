import { expect, fn, userEvent, waitFor, within } from 'storybook/test'
import type { Meta, StoryObj } from '@storybook/react-vite'
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
