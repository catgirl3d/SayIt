import { useEffect, useRef, useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, waitFor, within } from 'storybook/test'
import { Button } from '@/components/ui/button'
import { ModelPicker, RecommendedModels, type ModelPickerProps } from './ModelPicker'
import type { RemoteModel } from './aiProviderCatalog'

const models = [
  { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', input_price_per_million: 3, output_price_per_million: 15 },
  { id: 'openai/gpt-5-mini', name: 'GPT-5 mini', input_price_per_million: 0.25, output_price_per_million: 2 },
  { id: 'deepseek/deepseek-r1:free', name: 'DeepSeek R1 (free)', input_price_per_million: 0, output_price_per_million: 0 },
  { id: 'meta-llama/llama-4-maverick', name: 'Llama 4 Maverick' },
  { id: 'qwen/qwen3-235b-a22b', name: 'Qwen3 235B A22B', input_price_per_million: 0.002, output_price_per_million: 0.006 },
] satisfies RemoteModel[]

function ControlledPicker(props: ModelPickerProps) {
  const rowRef = useRef<HTMLDivElement>(null)
  const [value, setValue] = useState(props.value)
  const [inputValue, setInputValue] = useState(props.inputValue)

  // Storybook Controls can change args after mount; keep the local state in sync.
  useEffect(() => {
    setValue(props.value)
  }, [props.value])
  useEffect(() => {
    setInputValue(props.inputValue)
  }, [props.inputValue])

  // Tag mode adds a chip; plain mode turns the picked id into the field's text.
  const add = (id: string) => {
    props.onAdd(id)
    if (props.multiple) setValue((current) => (current.includes(id) ? current : [...current, id]))
    else setInputValue(id)
  }

  return (
    <div className="w-[30rem]">
      <label htmlFor="story-model-field" className="mb-1 block text-sm text-muted-foreground">Model</label>
      {/* Mirrors the editor: the field shares a row with a button, and the list spans the whole row. */}
      <div ref={rowRef} className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <ModelPicker
            {...props}
            anchorRef={rowRef}
            inputId="story-model-field"
            value={value}
            inputValue={inputValue}
            onInputChange={(text) => {
              props.onInputChange(text)
              setInputValue(text)
            }}
            onAdd={add}
            onRemove={(id) => {
              props.onRemove(id)
              setValue((current) => current.filter((item) => item !== id))
            }}
          />
        </div>
        <Button variant="outline" size="sm" className="h-9 shrink-0">Load models</Button>
      </div>
      <RecommendedModels
        models={props.recommended ?? []}
        chosen={props.multiple ? value : [inputValue.trim()]}
        onPick={add}
      />
    </div>
  )
}

const meta = {
  title: 'settings/ModelPicker',
  component: ModelPicker,
  args: {
    models,
    value: ['openai/gpt-5-mini'],
    multiple: true,
    inputValue: '',
    placeholder: 'Add another…',
    onAdd: fn(),
    onRemove: fn(),
    onInputChange: fn(),
  },
  parameters: { layout: 'centered' },
  render: (args) => <ControlledPicker {...args} />,
} satisfies Meta<typeof ModelPicker>

export default meta
type Story = StoryObj<typeof meta>

function bodyOf(canvasElement: HTMLElement) {
  // The dropdown is portaled into document.body, outside the story canvas.
  return within(canvasElement.ownerDocument.body)
}

export const ChosenModel: Story = {}

/** A preset with curated models: one-click picks under the field, and the crown on their rows in the list. */
export const RecommendedPicks: Story = {
  args: { value: [], placeholder: 'Model id, or load the list', recommended: ['openai/gpt-5-mini', 'anthropic/claude-sonnet-4'] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = bodyOf(canvasElement)

    // The crown alone labels the picks; the word lives in its tooltip.
    await expect(canvas.queryByText('Recommended')).toBeNull()
    await userEvent.hover(canvas.getByLabelText('Recommended'))
    await expect(await body.findByText('Recommended')).toBeVisible()
  },
}

export const PickRecommended: Story = {
  args: { value: [], recommended: ['openai/gpt-5-mini', 'anthropic/claude-sonnet-4'], onAdd: fn() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    const body = bodyOf(canvasElement)

    await userEvent.click(canvas.getByRole('button', { name: 'openai/gpt-5-mini' }))
    await expect(args.onAdd).toHaveBeenCalledWith('openai/gpt-5-mini')
    await expect(canvas.getByRole('button', { name: 'Remove openai/gpt-5-mini' })).toBeVisible()
    // A chosen recommendation leaves the row; the other one stays offered.
    await expect(canvas.queryByRole('button', { name: 'openai/gpt-5-mini' })).toBeNull()
    await expect(canvas.getByRole('button', { name: 'anthropic/claude-sonnet-4' })).toBeVisible()

    // The loaded list marks recommended rows with the crown, without changing the sort order.
    await userEvent.click(canvas.getByRole('combobox', { name: 'Model' }))
    const listbox = within(await body.findByRole('listbox'))
    await expect(within(listbox.getByRole('option', { name: /claude sonnet 4/i })).getByRole('img', { name: 'Recommended' })).toBeVisible()
    await expect(listbox.getAllByRole('img', { name: 'Recommended' })).toHaveLength(2)
  },
}

export const SeveralChosenModels: Story = {
  args: { value: ['openai/gpt-5-mini', 'anthropic/claude-sonnet-4', 'qwen/qwen3-235b-a22b'] },
}

export const OpenCatalog: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = bodyOf(canvasElement)

    await userEvent.click(canvas.getByRole('combobox', { name: 'Model' }))

    const listbox = within(await body.findByRole('listbox'))
    await expect(listbox.getAllByRole('option')).toHaveLength(models.length)
    await expect(listbox.getByRole('option', { name: /gpt-5 mini/i })).toHaveAttribute('aria-selected', 'true')
    await expect(listbox.getByRole('option', { name: /claude sonnet 4/i })).toHaveAttribute('aria-selected', 'false')

    const paid = listbox.getByRole('option', { name: /claude sonnet 4/i })
    await expect(paid).toHaveTextContent('$3.00')
    await expect(paid).toHaveTextContent('$15.00')

    await expect(listbox.getByRole('option', { name: /qwen3/i })).toHaveTextContent('$0.006')
    await expect(listbox.getByRole('option', { name: /deepseek r1/i })).toHaveTextContent('Free')

    const unknownPrice = listbox.getByRole('option', { name: /llama 4 maverick/i })
    await expect(unknownPrice).not.toHaveTextContent('$')
    await expect(unknownPrice).not.toHaveTextContent('Free')
  },
}

export const EscapeClosesListOnly: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = bodyOf(canvasElement)
    const field = canvas.getByRole('combobox', { name: 'Model' })

    await userEvent.click(field)
    await body.findByRole('listbox')

    const loadModels = canvas.getByRole('button', { name: 'Load models' })
    loadModels.focus()
    await expect(loadModels).toHaveFocus()

    const modalCapture = fn()
    const document = canvasElement.ownerDocument
    document.addEventListener('keydown', modalCapture, true)
    try {
      await userEvent.keyboard('{Escape}')

      await waitFor(() => expect(body.queryByRole('listbox')).toBeNull())
      await expect(field).toHaveFocus()
      await expect(modalCapture).not.toHaveBeenCalled()
    } finally {
      document.removeEventListener('keydown', modalCapture, true)
    }
  },
}

export const AnchorRowPressClosesList: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = bodyOf(canvasElement)

    await userEvent.click(canvas.getByRole('combobox', { name: 'Model' }))
    await body.findByRole('listbox')

    await userEvent.click(canvas.getByRole('button', { name: 'Load models' }))
    await waitFor(() => expect(body.queryByRole('listbox')).toBeNull())
  },
}

export const OpensUpwardNearBottom: Story = {
  parameters: { layout: 'fullscreen' },
  render: (args) => (
    <div className="fixed inset-x-0 bottom-6 px-6">
      <ControlledPicker {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = bodyOf(canvasElement)
    const loadModels = canvas.getByRole('button', { name: 'Load models' })
    const row = loadModels.parentElement
    if (!row) throw new Error('Expected the load-models button to be inside the picker anchor row')

    // jsdom has no layout; keep the real viewport height and provide the bottom-aligned row box.
    const currentRect = row.getBoundingClientRect()
    const originalDescriptor = Object.getOwnPropertyDescriptor(row, 'getBoundingClientRect')
    let mockedGeometry = false
    if (currentRect.width === 0 || currentRect.height === 0) {
      const viewportHeight = canvasElement.ownerDocument.defaultView?.innerHeight
      if (viewportHeight === undefined) throw new Error('Expected a viewport for the fullscreen story')
      const bottom = viewportHeight - 24
      Object.defineProperty(row, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
          x: 24,
          y: bottom - 36,
          left: 24,
          top: bottom - 36,
          right: 504,
          bottom,
          width: 480,
          height: 36,
          toJSON: () => ({}),
        }),
      })
      mockedGeometry = true
    }

    try {
      await userEvent.click(canvas.getByRole('combobox', { name: 'Model' }))
      const listbox = await body.findByRole('listbox')
      const panel = listbox.parentElement
      if (!panel) throw new Error('Expected the listbox to be inside its portaled panel')

      await expect(panel.style.bottom).not.toBe('')
      await expect(panel.style.top).toBe('')
    } finally {
      if (mockedGeometry) {
        if (originalDescriptor) Object.defineProperty(row, 'getBoundingClientRect', originalDescriptor)
        else Reflect.deleteProperty(row, 'getBoundingClientRect')
      }
    }
  },
}

export const FilterByTyping: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = bodyOf(canvasElement)

    await userEvent.type(canvas.getByRole('combobox', { name: 'Model' }), 'qwen')

    const listbox = within(await body.findByRole('listbox'))
    await expect(listbox.getByRole('option', { name: /qwen3/i })).toBeVisible()
    await expect(listbox.queryByRole('option', { name: /claude/i })).toBeNull()
    // Text the catalog does not list exactly can still be added as typed.
    await expect(listbox.getByRole('option', { name: /add “qwen”/i })).toBeVisible()
  },
}

export const AddCustomId: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)

    await userEvent.type(canvas.getByRole('combobox', { name: 'Model' }), 'my/private-model')
    await userEvent.click(await within(canvasElement.ownerDocument.body).findByRole('option', { name: /add “my\/private-model”/i }))

    await expect(args.onAdd).toHaveBeenCalledWith('my/private-model')
    await expect(canvas.getByRole('button', { name: 'Remove my/private-model' })).toBeVisible()
  },
}

export const ToggleRows: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    const body = bodyOf(canvasElement)

    await userEvent.click(canvas.getByRole('combobox', { name: 'Model' }))
    const listbox = within(await body.findByRole('listbox'))

    await userEvent.click(listbox.getByRole('option', { name: /claude sonnet 4/i }))
    await expect(args.onAdd).toHaveBeenCalledWith('anthropic/claude-sonnet-4')
    await expect(canvas.getByRole('button', { name: 'Remove anthropic/claude-sonnet-4' })).toBeVisible()
    // Several models can be chosen, so the list stays open for the next pick.
    await expect(body.getByRole('listbox')).toBeVisible()

    await userEvent.click(listbox.getByRole('option', { name: /gpt-5 mini/i }))
    await expect(args.onRemove).toHaveBeenCalledWith('openai/gpt-5-mini')
    await expect(canvas.queryByRole('button', { name: 'Remove openai/gpt-5-mini' })).toBeNull()
  },
}

/** An existing card holds one model: a plain field whose text is the model, with no chips. */
export const SingleModelField: Story = {
  args: { multiple: false, value: [], inputValue: 'openai/gpt-5-mini', placeholder: 'Model id, or load the list' },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    const body = bodyOf(canvasElement)

    const field = canvas.getByRole('combobox', { name: 'Model' })
    await expect(field).toHaveValue('openai/gpt-5-mini')
    await expect(canvas.queryAllByRole('button', { name: /^remove /i })).toHaveLength(0)

    // The list opens unfiltered even though the field holds a model, with that model marked.
    await userEvent.click(field)
    const listbox = within(await body.findByRole('listbox'))
    await expect(listbox.getAllByRole('option')).toHaveLength(models.length)
    await expect(listbox.getByRole('option', { name: /gpt-5 mini/i })).toHaveAttribute('aria-selected', 'true')

    // Picking replaces the text and closes the list.
    await userEvent.click(listbox.getByRole('option', { name: /claude sonnet 4/i }))
    await expect(args.onAdd).toHaveBeenCalledWith('anthropic/claude-sonnet-4')
    await expect(field).toHaveValue('anthropic/claude-sonnet-4')
    await waitFor(() => expect(body.queryByRole('listbox')).toBeNull())
  },
}

export const SingleModelWithoutCatalog: Story = {
  args: { models: [], multiple: false, value: [], inputValue: 'openai/gpt-5-mini', placeholder: 'Model id, or load the list' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = bodyOf(canvasElement)

    const field = canvas.getByRole('textbox', { name: 'Model' })
    await userEvent.clear(field)
    await userEvent.type(field, 'my/private-model')

    await expect(field).toHaveValue('my/private-model')
    await expect(body.queryByRole('listbox')).toBeNull()
  },
}

export const RemoveChip: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)

    await userEvent.click(canvas.getByRole('button', { name: 'Remove openai/gpt-5-mini' }))

    await expect(args.onRemove).toHaveBeenCalledWith('openai/gpt-5-mini')
    await expect(canvas.queryByRole('button', { name: 'Remove openai/gpt-5-mini' })).toBeNull()
  },
}

export const WithoutCatalog: Story = {
  args: { models: [], value: [], placeholder: 'Model id, or load the list' },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    const body = bodyOf(canvasElement)

    // No list yet: the field is a plain tag input.
    const field = canvas.getByRole('textbox', { name: 'Model' })
    await userEvent.type(field, 'gpt-5-mini{Enter}')
    await expect(args.onAdd).toHaveBeenCalledWith('gpt-5-mini')
    await expect(canvas.getByRole('button', { name: 'Remove gpt-5-mini' })).toBeVisible()

    await userEvent.type(field, 'gpt-5.2,')
    await expect(args.onAdd).toHaveBeenCalledWith('gpt-5.2')

    await userEvent.type(field, '{Backspace}')
    await expect(args.onRemove).toHaveBeenCalledWith('gpt-5.2')
    await expect(body.queryByRole('listbox')).toBeNull()
  },
}

export const Disabled: Story = {
  args: { disabled: true, onAdd: fn(), onRemove: fn() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    const body = bodyOf(canvasElement)

    const field = canvas.getByRole('combobox', { name: 'Model' })
    await expect(field).toBeDisabled()
    await userEvent.click(field)
    await expect(body.queryByRole('listbox')).toBeNull()
    await expect(canvas.getByRole('button', { name: 'Remove openai/gpt-5-mini' })).toBeDisabled()
    await expect(args.onAdd).not.toHaveBeenCalled()
  },
}
