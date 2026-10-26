import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, waitFor, within } from 'storybook/test'
import WorkModeMigrationDialog from './WorkModeMigrationDialog'

const meta = {
  title: 'components/WorkModeMigrationDialog',
  component: WorkModeMigrationDialog,
  args: {
    onChoose: fn(),
  },
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof WorkModeMigrationDialog>

export default meta
type Story = StoryObj<typeof meta>

function bodyOf(canvasElement: HTMLElement) {
  return within(canvasElement.ownerDocument.body)
}

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const body = bodyOf(canvasElement)
    await expect(await body.findByRole('button', { name: /^Local/ })).toBeEnabled()
    expect(body.getByRole('button', { name: /^Cloud API/ })).toBeEnabled()
  },
}

export const ChooseLocal: Story = {
  play: async ({ args, canvasElement }) => {
    await userEvent.click(await bodyOf(canvasElement).findByRole('button', { name: /^Local/ }))
    await waitFor(() => expect(args.onChoose).toHaveBeenCalledWith('local'))
  },
}

export const ChooseCloudApi: Story = {
  play: async ({ args, canvasElement }) => {
    await userEvent.click(await bodyOf(canvasElement).findByRole('button', { name: /^Cloud API/ }))
    await waitFor(() => expect(args.onChoose).toHaveBeenCalledWith('cloud_api'))
  },
}

export const Pending: Story = {
  args: {
    onChoose: fn(() => new Promise<void>(() => undefined)),
  },
  play: async ({ canvasElement }) => {
    const body = bodyOf(canvasElement)
    const local = await body.findByRole('button', { name: /^Local/ })
    const cloud = body.getByRole('button', { name: /^Cloud API/ })

    await userEvent.click(local)

    await waitFor(() => expect(local).toBeDisabled())
    expect(local).toHaveAttribute('aria-busy', 'true')
    expect(local.querySelector('.animate-spin')).not.toBeNull()
    expect(cloud).toBeDisabled()
  },
}

export const ErrorState: Story = {
  args: {
    onChoose: fn(async () => {
      throw new Error('Could not switch the mode')
    }),
  },
  play: async ({ canvasElement }) => {
    const body = bodyOf(canvasElement)
    await userEvent.click(await body.findByRole('button', { name: /^Local/ }))

    await expect(await body.findByRole('alert')).toHaveTextContent('Could not switch the mode')
    await waitFor(() => expect(body.getByRole('button', { name: /^Local/ })).toBeEnabled())
    expect(body.getByRole('button', { name: /^Cloud API/ })).toBeEnabled()
  },
}

export const EscapeDoesNotClose: Story = {
  play: async ({ canvasElement }) => {
    const body = bodyOf(canvasElement)
    await body.findByRole('dialog')

    await userEvent.keyboard('{Escape}')

    expect(body.getByRole('dialog')).toBeInTheDocument()
  },
}
