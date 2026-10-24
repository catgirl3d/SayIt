import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { DragHandle, moveItem, useSortable } from './sortable'

interface SortableDemoProps {
  items: readonly string[]
}

function SortableDemo({ items }: SortableDemoProps) {
  const [rows, setRows] = useState(() => [...items])
  const sortable = useSortable({
    onMove: (from, to) => setRows((current) => moveItem(current, from, to)),
  })

  return (
    <div className="w-full max-w-sm space-y-2">
      {rows.map((label, index) => (
        <div
          key={label}
          {...sortable.rowProps(index)}
          className={[
            'group flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm',
            sortable.rowClassName(index),
          ].filter(Boolean).join(' ')}
        >
          <DragHandle {...sortable.handleProps(index, label)} />
          <span className="min-w-0 flex-1 truncate">{label}</span>
        </div>
      ))}
    </div>
  )
}

const meta = {
  title: 'ui/sortable',
  component: SortableDemo,
  parameters: {
    layout: 'centered',
  },
} satisfies Meta<typeof SortableDemo>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    items: ['Intent processing', 'Faithful transcription', 'Translate to English'],
  },
}

export const SingleItem: Story = {
  args: {
    items: ['Faithful transcription'],
  },
}

export const LongLabels: Story = {
  args: {
    items: [
      'Whisper large-v3-turbo multilingual transcription',
      'Cloud transcription with background noise handling',
      'Post-process the result with the active prompt preset',
    ],
  },
}
