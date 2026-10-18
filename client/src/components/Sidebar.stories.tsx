import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import Sidebar from './Sidebar'

const meta = {
  title: 'components/Sidebar',
  component: Sidebar,
  parameters: {
    layout: 'fullscreen',
    tauri: {
      settings: {
        workMode: 'server',
      },
    },
  },
} satisfies Meta<typeof Sidebar>

export default meta
type Story = StoryObj<typeof meta>

const settingsPages = ['General', 'Audio & Mic', 'Shortcuts', 'Appearance', 'Usage', 'Diagnostics']

export const HistoryActive: Story = {
  parameters: {
    router: { initialEntries: ['/history'] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    // The settings group stays folded until it is opened.
    await expect(canvas.getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-expanded', 'false')
    for (const page of settingsPages) await expect(canvas.queryByRole('link', { name: page })).toBeNull()
  },
}

export const AudioSettingsActive: Story = {
  parameters: {
    router: { initialEntries: ['/audio'] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    // Landing on a settings page opens the group so the current entry is visible.
    await expect(canvas.getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-expanded', 'true')
    await expect(canvas.getByRole('link', { name: 'Audio & Mic' })).toHaveAttribute('aria-current', 'page')
    for (const page of settingsPages) await expect(canvas.getByRole('link', { name: page })).toBeVisible()
  },
}

export const SettingsGroupToggle: Story = {
  parameters: {
    router: { initialEntries: ['/history'] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const toggle = canvas.getByRole('button', { name: 'Settings' })

    await userEvent.click(toggle)
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    for (const page of settingsPages) await expect(canvas.getByRole('link', { name: page })).toBeVisible()

    await userEvent.click(toggle)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await waitFor(() => expect(canvas.queryByRole('link', { name: 'General' })).toBeNull())
  },
}

export const SettingsGroupFoldedOnCurrentPage: Story = {
  parameters: {
    router: { initialEntries: ['/appearance'] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const toggle = canvas.getByRole('button', { name: 'Settings' })

    // Folding while on one of its pages is allowed; the heading keeps the accent.
    await userEvent.click(toggle)
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle).toHaveClass('text-sidebar-text-active')
    await expect(canvas.queryByRole('link', { name: 'Appearance' })).toBeNull()
  },
}
