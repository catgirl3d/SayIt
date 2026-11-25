// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { t } from '@/i18n'
import type { PromptPreset } from '@/services/store'
import PromptPresetSection from '../PromptPresetSection'

const builtinPresets: PromptPreset[] = [
  {
    id: 'intent',
    name: 'Intent processing',
    systemPrompt: 'Clean up the transcript while preserving intent.',
    builtin: true,
  },
  {
    id: 'faithful',
    name: 'Faithful processing',
    systemPrompt: 'Clean up the transcript without changing the wording.',
    builtin: true,
  },
]

const customPresetA: PromptPreset = {
  id: 'custom-a',
  name: 'Meeting notes',
  systemPrompt: 'Turn spoken updates into concise meeting notes with owners and action items.',
}

const customPresetB: PromptPreset = {
  id: 'custom-b',
  name: 'Email replies',
  systemPrompt: 'Turn spoken updates into concise email replies.',
}

/** The handle accessible name wraps the preset label in the sortable keyboard hint. */
function dragLabel(name: string): string {
  return t('ui.sortableAria', { label: t('promptPreset.drag', { name }) })
}

function dragHandles(): HTMLElement[] {
  return screen.queryAllByTestId('preset-drag-handle')
}

type SectionProps = Parameters<typeof PromptPresetSection>[0]

function renderSection(presets: PromptPreset[], overrides: Partial<SectionProps> = {}) {
  const props: SectionProps = {
    presets,
    activePresetId: 'intent',
    editingPreset: null,
    presetShortcuts: {},
    editingShortcut: '',
    promptLanguage: 'en',
    onSelectPreset: vi.fn(),
    onPromptLanguageChange: vi.fn(),
    onStartNewPreset: vi.fn(),
    onStartEditing: vi.fn(),
    onEditingPresetChange: vi.fn(),
    onEditingShortcutChange: vi.fn(),
    onCancelEditing: vi.fn(),
    onSavePreset: vi.fn(),
    onDeletePreset: vi.fn(),
    onMovePreset: vi.fn(),
    ...overrides,
  }
  return { props, ...render(<PromptPresetSection {...props} />) }
}

const placeholders = () => screen.queryAllByTestId('preset-drag-placeholder')

describe('PromptPresetSection sortable handles', () => {
  it('shows tall visible handles for custom presets and equal spacers for built-in rows', () => {
    renderSection([...builtinPresets, customPresetA, customPresetB])

    const handles = dragHandles()
    expect(handles.length).toBe(2)
    const namedHandles = [
      { name: 'Meeting notes', handle: screen.getByRole('button', { name: dragLabel('Meeting notes') }) },
      { name: 'Email replies', handle: screen.getByRole('button', { name: dragLabel('Email replies') }) },
    ]
    expect(placeholders().length).toBe(2)

    for (const { name, handle } of namedHandles) {
      expect(handle.getAttribute('aria-label')?.startsWith(t('promptPreset.drag', { name }))).toBe(true)
      expect(handle.classList.contains('text-muted-foreground/0')).toBe(false)
      expect(handle.classList.contains('text-muted-foreground/60')).toBe(true)
      expect(handle.classList.contains('-ml-1')).toBe(true)
      expect(handle.classList.contains('shrink-0')).toBe(true)
      expect(handle.classList.contains('p-1')).toBe(true)

      const icon = handle.querySelector('svg')
      expect(icon).not.toBeNull()
      expect(icon!.classList.contains('h-3.5')).toBe(true)
      expect(icon!.classList.contains('w-3.5')).toBe(true)
    }

    for (const placeholder of placeholders()) {
      expect(placeholder.getAttribute('aria-hidden')).toBe('true')
      expect(placeholder.hasAttribute('tabindex')).toBe(false)
      expect(placeholder.hasAttribute('draggable')).toBe(false)
      expect(placeholder.hasAttribute('role')).toBe(false)
      for (const className of ['-ml-1', 'box-content', 'h-3.5', 'w-3.5', 'shrink-0', 'p-1']) {
        expect(placeholder.classList.contains(className)).toBe(true)
      }
      const circle = placeholder.nextElementSibling
      expect(circle).not.toBeNull()
      expect(circle!.classList.contains('h-4')).toBe(true)
      expect(circle!.classList.contains('w-4')).toBe(true)
    }
  })

  it('keeps built-in and custom rows intact without handles when only one custom preset exists', () => {
    renderSection([...builtinPresets, customPresetA])

    expect(dragHandles().length).toBe(0)
    expect(placeholders().length).toBe(0)
    expect(screen.getByText('Meeting notes')).toBeTruthy()
    expect(screen.getByText(t('builtinPreset.intent'))).toBeTruthy()
    expect(screen.getByText(t('builtinPreset.faithful'))).toBeTruthy()
  })

  it('adds and removes the handle column as the custom preset count crosses one', () => {
    const { props, rerender } = renderSection([...builtinPresets, customPresetA])

    expect(dragHandles().length).toBe(0)
    expect(placeholders().length).toBe(0)

    rerender(<PromptPresetSection {...props} presets={[...builtinPresets, customPresetA, customPresetB]} />)
    expect(dragHandles().length).toBe(2)
    expect(placeholders().length).toBe(2)

    rerender(<PromptPresetSection {...props} presets={[...builtinPresets, customPresetA]} />)
    expect(dragHandles().length).toBe(0)
    expect(placeholders().length).toBe(0)
  })

  it('moves custom presets by their index inside the custom segment', () => {
    const onMovePreset = vi.fn()
    renderSection([builtinPresets[0], customPresetA, customPresetB], { onMovePreset })

    fireEvent.keyDown(screen.getByRole('button', { name: dragLabel('Meeting notes') }), {
      key: 'ArrowDown',
    })
    fireEvent.keyDown(screen.getByRole('button', { name: dragLabel('Email replies') }), {
      key: 'ArrowUp',
    })

    expect(onMovePreset).toHaveBeenCalledWith(0, 1)
    expect(onMovePreset).toHaveBeenCalledWith(1, 0)
    expect(onMovePreset).toHaveBeenCalledTimes(2)
  })

  it('selects a built-in row from its spacer and keeps handle clicks from selecting', () => {
    const onSelectPreset = vi.fn()
    renderSection([...builtinPresets, customPresetA, customPresetB], { onSelectPreset })

    const intentRow = screen.getByText(t('builtinPreset.intent')).closest('.group')
    expect(intentRow).not.toBeNull()
    const intentPlaceholder = intentRow!.querySelector('[data-testid="preset-drag-placeholder"]')
    expect(intentPlaceholder).not.toBeNull()

    fireEvent.click(intentPlaceholder!)
    expect(onSelectPreset).toHaveBeenCalledTimes(1)
    expect(onSelectPreset).toHaveBeenCalledWith('intent')

    fireEvent.click(screen.getByRole('button', { name: dragLabel('Meeting notes') }))
    expect(onSelectPreset).toHaveBeenCalledTimes(1)
  })
})
