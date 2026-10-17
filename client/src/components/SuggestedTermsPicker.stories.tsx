import type { Meta, StoryObj } from '@storybook/react-vite'
import SuggestedTermsPicker, { type SuggestionSet } from './SuggestedTermsPicker'

const suggestionSets: SuggestionSet[] = [
  {
    key: 'engineering',
    label: 'Engineering',
    words: ['TypeScript', 'React', 'WebView2', 'Tauri', 'Storybook'],
  },
  {
    key: 'planning',
    label: 'Planning',
    words: ['milestone', 'release notes', 'regression test', 'follow-up'],
  },
  {
    key: 'product',
    label: 'Product',
    words: ['workspace', 'shortcut', 'dictation', 'transcript'],
  },
]

const meta = {
  title: 'components/SuggestedTermsPicker',
  component: SuggestedTermsPicker,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof SuggestedTermsPicker>

export default meta
type Story = StoryObj<typeof meta>

export const WithSelectedTerms: Story = {
  args: {
    sets: suggestionSets,
    selected: ['TypeScript', 'Tauri', 'milestone'],
    canAdd: () => true,
    onToggle: () => undefined,
    budgetText: '3 of 12 terms selected',
  },
}

export const BudgetReached: Story = {
  args: {
    sets: suggestionSets,
    selected: ['TypeScript', 'React', 'WebView2'],
    canAdd: (word) => word === 'TypeScript' || word === 'React' || word === 'WebView2',
    onToggle: () => undefined,
    budgetText: '3 of 3 terms selected',
  },
}
