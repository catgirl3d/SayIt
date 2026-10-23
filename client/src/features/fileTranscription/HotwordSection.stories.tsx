import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import HotwordSection from './HotwordSection'
import { buildHotwordPlan, type HotwordCategorySelection, type HotwordMode } from './hotwordPlan'
import type { FoldedHotwordDelivery } from '@/lib/asrModels'
import type { HotwordCatalog } from '@/services/hotwords/settings'

const catalog: HotwordCatalog = {
  builtinSetWords: {
    ai: ['ChatGPT', 'Claude', 'Gemini'],
    code: ['Git', 'GitHub Actions', 'Kubernetes', 'Tauri'],
  },
  builtinSetActive: { ai: true, code: false },
  customThemes: [{ id: 'hospital', name: 'Hospital', words: ['MRI', 'CT scan'] }],
  customThemeActive: { hospital: false },
  activeWords: ['ChatGPT', 'Claude', 'Gemini'],
}

const overBudgetCatalog: HotwordCatalog = {
  ...catalog,
  activeWords: Array.from({ length: 510 }, (_, index) => `Term${index}`),
}

const wordCapCatalog: HotwordCatalog = {
  ...catalog,
  activeWords: Array.from({ length: 101 }, (_, index) => `Term${index}`),
}

interface HarnessProps {
  initialMode?: HotwordMode
  initialSelection?: HotwordCategorySelection
  catalog?: HotwordCatalog | null
  catalogError?: string
  provider?: string | null
  providerClientCap?: number | null
  providerDelivery?: FoldedHotwordDelivery | null
  deepgramKeytermsEnabled?: boolean
  disabled?: boolean
  onModeChange?: (mode: HotwordMode) => void
  onSelectionChange?: (selection: HotwordCategorySelection) => void
  onRetry: () => void
}

function Harness({
  initialMode = 'none',
  initialSelection = { builtinKeys: [], themeIds: [] },
  catalog: catalogValue = catalog,
  catalogError = '',
  provider = 'qwen',
  providerClientCap = null,
  providerDelivery = 'sent',
  deepgramKeytermsEnabled = false,
  disabled = false,
  onModeChange,
  onSelectionChange,
  onRetry,
}: HarnessProps) {
  const [mode, setMode] = useState(initialMode)
  const [selection, setSelection] = useState(initialSelection)
  const plan = buildHotwordPlan({
    mode,
    selection,
    catalog: catalogValue,
    engine: 'cloud',
    provider,
    providerClientCap,
    providerDelivery,
    deepgramKeytermsEnabled,
  })

  return (
    <div className="w-72 rounded-lg border border-border bg-card p-3">
      <HotwordSection
        mode={mode}
        onModeChange={(next) => {
          setMode(next)
          onModeChange?.(next)
        }}
        selection={selection}
        onSelectionChange={(next) => {
          setSelection(next)
          onSelectionChange?.(next)
        }}
        catalog={catalogValue}
        catalogError={catalogError}
        plan={plan}
        disabled={disabled}
        onRetry={onRetry}
      />
    </div>
  )
}

const meta = {
  title: 'features/fileTranscription/HotwordSection',
  component: Harness,
  args: {
    onModeChange: fn(),
    onSelectionChange: fn(),
    onRetry: fn(),
  },
} satisfies Meta<typeof Harness>

export default meta
type Story = StoryObj<typeof meta>

export const ActiveHotwords: Story = {
  args: { initialMode: 'active' },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)

    await expect(canvas.getByText('Active hotwords: 3')).toBeVisible()
    await userEvent.click(canvas.getByRole('radio', { name: 'Choose' }))
    await expect(args.onModeChange).toHaveBeenCalledWith('selected')
  },
}

export const SelectedCategories: Story = {
  args: {
    initialMode: 'selected',
    initialSelection: { builtinKeys: ['ai', 'code'], themeIds: ['hospital'] },
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    const code = canvas.getByRole('checkbox', { name: /Programming/ })

    await expect(code).toHaveAttribute('aria-checked', 'true')
    await expect(canvas.getByText('Selected hotwords: 9')).toBeVisible()
    await userEvent.click(code)
    await expect(code).toHaveAttribute('aria-checked', 'false')
    await expect(canvas.getByText('Selected hotwords: 5')).toBeVisible()
    await expect(args.onSelectionChange).toHaveBeenCalledWith({
      builtinKeys: ['ai'],
      themeIds: ['hospital'],
    })
  },
}

export const NoHotwords: Story = {
  args: { initialMode: 'none' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await expect(canvas.getByText('Hotwords are not used')).toBeVisible()
    await expect(canvas.queryAllByRole('checkbox')).toHaveLength(0)
  },
}

export const NoHotwordsHidesCatalogFailure: Story = {
  args: { initialMode: 'none', catalog: null, catalogError: 'settings store unavailable' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await expect(canvas.getByText('Hotwords are not used')).toBeVisible()
    await expect(canvas.queryByText(/Could not read hotwords/)).toBeNull()
  },
}

export const LoadingCatalog: Story = {
  args: { initialMode: 'active', catalog: null, catalogError: '' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await expect(canvas.getByText('Reading hotwords…')).toBeVisible()
  },
}

export const DeepgramGateOff: Story = {
  args: { initialMode: 'active', provider: 'deepgram', deepgramKeytermsEnabled: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await expect(canvas.getByText(/is turned off in the Deepgram profile/)).toBeVisible()
    await expect(canvas.getByRole('link', { name: /Open voice engine settings/ })).toBeVisible()
  },
}

export const DeepgramTokenBudget: Story = {
  args: { initialMode: 'active', provider: 'deepgram', deepgramKeytermsEnabled: true, catalog: overBudgetCatalog },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await expect(canvas.getByText(/Estimated hotword tokens/)).toBeVisible()
  },
}

export const WordCapReached: Story = {
  args: { initialMode: 'active', provider: 'gemini_transcribe', providerClientCap: 100, catalog: wordCapCatalog },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await expect(canvas.getByText(/use only the first 100 words/)).toBeVisible()
  },
}

export const HotwordsLoadError: Story = {
  args: { initialMode: 'active', catalog: null, catalogError: 'settings store unavailable' },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)

    await expect(canvas.getByText(/Could not read hotwords/)).toBeVisible()
    await userEvent.click(canvas.getByRole('button', { name: 'Retry' }))
    await expect(args.onRetry).toHaveBeenCalled()
  },
}

export const DisabledWhileRunning: Story = {
  args: {
    disabled: true,
    initialMode: 'selected',
    initialSelection: { builtinKeys: ['ai'], themeIds: [] },
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    const choose = canvas.getByRole('radio', { name: 'Choose' })

    await expect(choose).toBeDisabled()
    await expect(canvas.getByRole('radio', { name: 'None' })).toBeDisabled()
    await expect(canvas.getByRole('checkbox', { name: /AI terms/ })).toBeDisabled()
    choose.click()
    await expect(args.onModeChange).not.toHaveBeenCalled()
  },
}
