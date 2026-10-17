import type { Meta, StoryObj } from '@storybook/react-vite'
import { getBuiltinPromptPresets, type PromptPreset } from '@/services/store'
import { BUILTIN_APP_RULES } from '@/services/personalization/defaults'
import type { AppPromptRule } from '@/services/personalization/types'
import AppPromptRulesSection from './AppPromptRulesSection'

const presets: PromptPreset[] = [
  ...getBuiltinPromptPresets('en').slice(0, 3),
  {
    id: 'storybook-meeting-notes',
    name: 'Meeting notes',
    systemPrompt: 'Turn spoken updates into concise meeting notes with clear action items.',
  },
]

const rules: AppPromptRule[] = [
  ...BUILTIN_APP_RULES.map((rule) => ({
    ...rule,
    enabled: rule.id === 'vscode',
    matcher: { ...rule.matcher },
  })),
  {
    id: 'storybook-browser-notes',
    appId: 'storybook-browser-notes',
    name: 'Browser notes',
    enabled: false,
    presetId: 'storybook-meeting-notes',
    promptAppend: 'Keep web research notes factual and preserve links and product names.',
    matcher: {
      processNames: ['chrome.exe', 'msedge.exe'],
      windowTitleIncludes: ['Documentation'],
    },
  },
]

const callbacks = {
  onSaveRule: () => undefined,
  onToggleRule: () => undefined,
  onMoveRule: () => undefined,
  onResetRule: () => undefined,
  onCreateRule: () => undefined,
  onDeleteRule: () => undefined,
}

const meta = {
  title: 'settings/AppPromptRulesSection',
  component: AppPromptRulesSection,
} satisfies Meta<typeof AppPromptRulesSection>

export default meta
type Story = StoryObj<typeof meta>

export const ConfiguredRules: Story = {
  args: {
    presets,
    rules,
    ...callbacks,
  },
}
