import { fireEvent, waitFor } from '@testing-library/react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import Dictionary from './Dictionary'

const meta = {
  title: 'pages/Dictionary',
  component: Dictionary,
  parameters: {
    layout: 'fullscreen',
    tauri: {
      settings: {
        builtinSetWords: { ai: ['SayIt', 'Storybook'] },
        builtinSetActive: { ai: true },
        customHotwordThemes: [{ id: 'storybook', name: 'Storybook terms', words: ['Vitest'] }],
        customThemeActive: { storybook: true },
        manualHotwords: [],
      },
      commands: {
        asr_hotword_capability_matrix: () => ({
          deepgram: { delivery: 'vocabulary', clientCap: 40 },
          server: { delivery: 'context', clientCap: null },
        }),
      },
    },
  },
} satisfies Meta<typeof Dictionary>

export default meta
type Story = StoryObj<typeof meta>

export const Loaded: Story = {
  play: async ({ canvasElement }) => {
    const trigger = canvasElement.querySelector('svg.lucide-info')?.parentElement
    if (!trigger) throw new Error('Dictionary capability information trigger is missing')
    fireEvent.mouseEnter(trigger)

    await waitFor(() => {
      const canvasText = canvasElement.textContent ?? ''
      const bodyText = document.body.textContent ?? ''
      if (!canvasText.includes('SayIt') || !bodyText.includes('Deepgram')) {
        throw new Error('Dictionary did not render the seeded hotword and capability payload')
      }
    })
  },
}
