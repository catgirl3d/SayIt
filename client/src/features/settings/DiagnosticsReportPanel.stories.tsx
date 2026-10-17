import { fireEvent, waitFor } from '@testing-library/react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import DiagnosticsReportPanel from './DiagnosticsReportPanel'
import { diagnosticsPreviewFixture } from './diagnosticsPreviewFixture'

const diagnosticsSettings = {
  'speechInput.language': 'en',
  aiEnabled: true,
  'cloudAsr.provider': 'deepgram',
  'cloudAi.provider': 'openai',
  'localAsr.accelerator': 'auto',
}

const baseCommands = {
  get_diagnostics_preview: () => diagnosticsPreviewFixture,
  'plugin:dialog|save': () => 'C:\\Users\\Storybook\\Documents\\sayit-support-bundle.zip',
  create_public_diagnostics_bundle: () => 'C:\\Users\\Storybook\\AppData\\Local\\Temp\\sayit-public.zip',
  copy_diagnostics_zip: () => undefined,
  'plugin:shell|open': () => undefined,
}

const meta = {
  title: 'settings/DiagnosticsReportPanel',
  component: DiagnosticsReportPanel,
  parameters: {
    layout: 'padded',
    tauri: { commands: baseCommands, settings: diagnosticsSettings },
  },
} satisfies Meta<typeof DiagnosticsReportPanel>

export default meta
type Story = StoryObj<typeof meta>

export const Ready: Story = {}

export const BundleSaved: Story = {
  play: async () => {
    const createButton = Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Create support bundle')
    if (!(createButton instanceof HTMLButtonElement)) throw new Error('Support-bundle action is missing')
    fireEvent.click(createButton)
    await waitFor(() => {
      if (!document.body.textContent?.includes('Support bundle saved')) throw new Error('Saved support-bundle state is missing')
    })

    const issueButton = Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Report issue on GitHub')
    if (!(issueButton instanceof HTMLButtonElement)) throw new Error('GitHub issue action is missing')
    fireEvent.click(issueButton)
  },
}

export const BundleCreationError: Story = {
  parameters: {
    tauri: {
      commands: { ...baseCommands, create_public_diagnostics_bundle: () => { throw new Error('archive creation failed') } },
      settings: diagnosticsSettings,
    },
  },
  play: async () => {
    const createButton = Array.from(document.body.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Create support bundle')
    if (!(createButton instanceof HTMLButtonElement)) throw new Error('Support-bundle action is missing')
    fireEvent.click(createButton)
    await waitFor(() => {
      if (!document.body.textContent?.includes('The support bundle could not be created.')) throw new Error('Support-bundle error state is missing')
    })
  },
}
