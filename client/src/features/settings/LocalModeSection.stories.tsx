import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  availableModels,
  diagnosticsCpuOnly,
  diagnosticsWithGpu,
  downloadedModels,
  primaryModelId,
  secondaryModelId,
} from '@/storybook/localModelFixtures'
import LocalModeSection, { LocalModeAdvancedSection } from './LocalModeSection'

const meta = {
  title: 'settings/LocalModeSection',
  component: LocalModeSection,
} satisfies Meta<typeof LocalModeSection>

export default meta
type Story = StoryObj<typeof meta>

export const ModelsReady: Story = {
  args: { speechLanguage: 'uk' },
  parameters: {
    tauri: {
      commands: {
        list_available_models: () => availableModels,
        list_downloaded_models: () => downloadedModels,
        gguf_asr_diagnostics: () => diagnosticsWithGpu,
      },
      settings: {
        'localAsr.modelId': primaryModelId,
        'localAsr.downloadSource': 'HuggingFace',
      },
    },
  },
}

export const CatalogUnavailable: Story = {
  args: { speechLanguage: 'en' },
  parameters: {
    tauri: {
      commands: {
        list_available_models: () => { throw new Error('model catalog unavailable') },
        list_downloaded_models: () => [],
        gguf_asr_diagnostics: () => diagnosticsCpuOnly,
      },
      settings: {
        'localAsr.modelId': secondaryModelId,
        'localAsr.downloadSource': 'HuggingFace',
      },
    },
  },
}

export const AdvancedEngineSettings: Story = {
  args: { speechLanguage: 'en' },
  render: () => <LocalModeAdvancedSection />,
  parameters: {
    tauri: {
      commands: {
        gguf_asr_diagnostics: () => diagnosticsWithGpu,
        get_models_dir: () => ({
          current: 'D:/SayIt/models',
          default_dir: 'C:/Users/Storybook/AppData/Local/SayIt/models',
          is_custom: true,
        }),
      },
      settings: {
        'localAsr.modelId': primaryModelId,
        'localAsr.accelerator': 'gpu',
        'localAsr.unloadIdleMinutes': 30,
      },
    },
  },
}
