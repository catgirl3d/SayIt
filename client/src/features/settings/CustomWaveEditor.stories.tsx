import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, waitFor, within } from 'storybook/test'
import en from '@/i18n/locales/en.json'
import { CustomWaveEditor } from './CustomWaveEditor'
import { DEFAULT_CUSTOM_WAVE, type CustomWaveColors } from '@/lib/overlayWaveColors'

/** The hint the editor shows when a color is too dark for the black overlay. */
const TOO_DARK_HINT = en['appearance.wave.brightened']

/**
 * The editor is controlled, so the story keeps the value in state: a click or a typed HEX updates what is shown,
 * the same way AppearancePage drives it. `onChange` is the spy the play functions assert on.
 */
function ControlledCustomWaveEditor({ initial, onChange }: {
  initial: CustomWaveColors
  onChange: (next: CustomWaveColors) => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <div className="w-full max-w-2xl rounded-lg border border-border bg-card p-5">
      <CustomWaveEditor
        value={value}
        animate={false}
        onChange={(next) => {
          setValue(next)
          onChange(next)
        }}
      />
    </div>
  )
}

const meta = {
  title: 'settings/CustomWaveEditor',
  component: CustomWaveEditor,
  args: {
    value: DEFAULT_CUSTOM_WAVE,
    onChange: fn(),
    animate: false,
  },
  render: (args) => (
    <ControlledCustomWaveEditor initial={args.value} onChange={args.onChange} />
  ),
} satisfies Meta<typeof CustomWaveEditor>

export default meta
type Story = StoryObj<typeof meta>

/** Opens a color popover by its aria-label. The popover is portaled into document.body, outside the story canvas. */
async function openPicker(canvasElement: HTMLElement, label: string) {
  const canvas = within(canvasElement)
  await userEvent.click(canvas.getByRole('button', { name: label }))
  return within(canvasElement.ownerDocument.body).findByRole('dialog', { name: label })
}

/**
 * The brightened swatch has no accessible name. It is the aria-hidden span placed right after the hint text,
 * so it is located from that text.
 */
async function findBrightenedSwatch(canvasElement: HTMLElement): Promise<HTMLElement> {
  const hint = await within(canvasElement).findByText(TOO_DARK_HINT)
  const swatch = hint.nextElementSibling
  if (!(swatch instanceof HTMLElement)) throw new Error('Brightened swatch is missing after the hint text')
  return swatch
}

export const Solid: Story = {
  args: {
    value: { mode: 'solid', from: '#60a5fa', to: DEFAULT_CUSTOM_WAVE.to },
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('button', { name: '#60A5FA' })).toHaveAttribute('aria-pressed', 'true')
    // The custom picker shows a dashed "add" dot while the current color is one of the presets.
    await expect(canvas.getByRole('button', { name: 'Color' })).toBeVisible()

    await userEvent.click(canvas.getByRole('button', { name: '#F472B6' }))

    await expect(args.onChange).toHaveBeenLastCalledWith({ mode: 'solid', from: '#f472b6', to: DEFAULT_CUSTOM_WAVE.to })
    await waitFor(() => expect(canvas.getByRole('button', { name: '#F472B6' })).toHaveAttribute('aria-pressed', 'true'))
    await expect(canvas.getByRole('button', { name: '#60A5FA' })).toHaveAttribute('aria-pressed', 'false')
  },
}

export const SolidCustomColor: Story = {
  args: {
    value: { mode: 'solid', from: '#ff6b35', to: DEFAULT_CUSTOM_WAVE.to },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // Not a preset, so the custom picker is the selected control: it paints the given color, and no preset is pressed.
    await expect(canvas.getByRole('button', { name: 'Color' })).toHaveStyle({ backgroundColor: 'rgb(255, 107, 53)' })
    for (const name of ['#F472B6', '#A78BFA']) {
      await expect(canvas.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false')
    }
  },
}

export const SolidPopoverTypedHex: Story = {
  args: {
    value: { mode: 'solid', from: '#ff6b35', to: DEFAULT_CUSTOM_WAVE.to },
  },
  play: async ({ canvasElement, args }) => {
    const dialog = await openPicker(canvasElement, 'Color')
    const hexInput = within(dialog).getByRole('textbox', { name: 'Color HEX' })

    await userEvent.clear(hexInput)
    await userEvent.type(hexInput, '2DD4BF')

    // The typed value is reported in lowercase; the other stop of the color set is kept as it was.
    await expect(args.onChange).toHaveBeenLastCalledWith({ mode: 'solid', from: '#2dd4bf', to: DEFAULT_CUSTOM_WAVE.to })
    await expect(hexInput).toHaveValue('#2dd4bf')
  },
}

export const SolidPopoverEscape: Story = {
  args: {
    value: { mode: 'solid', from: '#ff6b35', to: DEFAULT_CUSTOM_WAVE.to },
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    const trigger = within(canvasElement).getByRole('button', { name: 'Color' })
    const dialog = await openPicker(canvasElement, 'Color')
    // Move focus into the panel first: the click already left focus on the trigger, so the focus check would pass without this.
    await userEvent.click(within(dialog).getByRole('textbox', { name: 'Color HEX' }))

    await userEvent.keyboard('{Escape}')

    await waitFor(() => expect(body.queryByRole('dialog', { name: 'Color' })).toBeNull())
    await expect(trigger).toHaveFocus()
  },
}

export const PopoverClosesOnOutsideClick: Story = {
  args: {
    value: { mode: 'solid', from: '#ff6b35', to: DEFAULT_CUSTOM_WAVE.to },
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    await openPicker(canvasElement, 'Color')

    // The story wrapper is outside both the panel and the trigger.
    await userEvent.click(canvasElement)

    await waitFor(() => expect(body.queryByRole('dialog', { name: 'Color' })).toBeNull())
  },
}

export const Gradient: Story = {
  args: {
    value: DEFAULT_CUSTOM_WAVE,
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('button', { name: '#A78BFA → #F472B6' })).toHaveAttribute('aria-pressed', 'true')

    await userEvent.click(canvas.getByRole('button', { name: '#22D3EE → #A3E635' }))

    await expect(args.onChange).toHaveBeenLastCalledWith({ mode: 'gradient', from: '#22d3ee', to: '#a3e635' })
    await waitFor(() => expect(canvas.getByRole('button', { name: '#22D3EE → #A3E635' })).toHaveAttribute('aria-pressed', 'true'))
  },
}

export const GradientCustomColors: Story = {
  args: {
    value: { mode: 'gradient', from: '#34d399', to: '#f59e0b' },
  },
  play: async ({ canvasElement, args }) => {
    const dialog = await openPicker(canvasElement, 'Start')
    const hexInput = within(dialog).getByRole('textbox', { name: 'Start HEX' })

    await userEvent.clear(hexInput)
    await userEvent.type(hexInput, '00ff00')

    await expect(args.onChange).toHaveBeenLastCalledWith({ mode: 'gradient', from: '#00ff00', to: '#f59e0b' })
    await expect(hexInput).toHaveValue('#00ff00')
  },
}

export const SolidTooDark: Story = {
  args: {
    value: { mode: 'solid', from: '#000080', to: DEFAULT_CUSTOM_WAVE.to },
  },
  play: async ({ canvasElement }) => {
    // The user's color is kept in the picker; the hint shows the brightened color that the overlay will draw.
    await expect(await within(canvasElement).findByText(TOO_DARK_HINT)).toBeVisible()
    // The expected swatch color is the fixed result of visibleOnBlack('#000080'), not a recomputation.
    const swatch = await findBrightenedSwatch(canvasElement)
    await expect(swatch).toHaveStyle({ backgroundColor: 'rgb(74, 126, 246)' })
  },
}

export const SolidBrightFromDarkTo: Story = {
  args: {
    value: { mode: 'solid', from: '#a3e635', to: '#000000' },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // Check the rendered state first, so the absent hint below cannot pass because nothing was rendered.
    await expect(canvas.getByRole('button', { name: '#A3E635' })).toHaveAttribute('aria-pressed', 'true')
    await expect(canvas.getByRole('radio', { name: 'Solid' })).toHaveAttribute('aria-checked', 'true')
    // Solid mode draws only the start color, so the dark end does not trigger the hint.
    await expect(canvas.queryByText(TOO_DARK_HINT)).toBeNull()

    // The same dark end does count in gradient mode, which shows the absence above comes from solid mode.
    await userEvent.click(canvas.getByRole('radio', { name: 'Gradient' }))
    await expect(await canvas.findByText(TOO_DARK_HINT)).toBeVisible()
  },
}

export const GradientTooDark: Story = {
  args: {
    value: { mode: 'gradient', from: '#1e1b4b', to: '#3b0764' },
  },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText(TOO_DARK_HINT)).toBeVisible()
    // Both ends are brightened and the five stops in between are interpolated. The expected stops are the fixed
    // result of the palette for these two colors, not a recomputation.
    const swatch = await findBrightenedSwatch(canvasElement)
    await expect(swatch).toHaveStyle({
      backgroundImage: 'linear-gradient(to right, rgb(125, 128, 185), rgb(130, 125, 192), rgb(136, 120, 197), rgb(143, 116, 202), rgb(152, 110, 205))',
    })
  },
}

export const ModeSwitch: Story = {
  args: {
    value: DEFAULT_CUSTOM_WAVE,
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('radio', { name: 'Solid' }))

    await expect(args.onChange).toHaveBeenLastCalledWith({ ...DEFAULT_CUSTOM_WAVE, mode: 'solid' })
    await expect(await canvas.findByRole('button', { name: '#A78BFA' })).toBeVisible()
    await expect(canvas.queryByRole('button', { name: '#A78BFA → #F472B6' })).toBeNull()
  },
}
