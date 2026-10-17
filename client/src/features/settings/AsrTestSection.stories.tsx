import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import AsrTestSection from './AsrTestSection'

function createTestWavBase64(): string {
  const sampleRate = 16_000
  const sampleCount = sampleRate
  const pcmBytes = sampleCount * 2
  const wav = new Uint8Array(44 + pcmBytes)
  const view = new DataView(wav.buffer)

  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) wav[offset + index] = value.charCodeAt(index)
  }

  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + pcmBytes, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, pcmBytes, true)

  for (let sample = 0; sample < sampleCount; sample += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * sample) / sampleRate) * 0x2000)
    view.setInt16(44 + sample * 2, value, true)
  }

  let binary = ''
  for (const byte of wav) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const testAudioBase64 = createTestWavBase64()

const meta = {
  title: 'settings/AsrTestSection',
  component: AsrTestSection,
} satisfies Meta<typeof AsrTestSection>

export default meta
type Story = StoryObj<typeof meta>

export const LocalSuccess: Story = {
  args: { workMode: 'local', speechLanguage: 'en' },
  parameters: {
    tauri: {
      commands: {
        get_test_audio_b64: () => testAudioBase64,
        run_asr_benchmark: () => ({
          text: 'The local recognition test completed successfully.',
          elapsed_ms: 280,
          model_id: 'sensevoice-small-gguf',
        }),
      },
      settings: { 'localAsr.modelId': 'sensevoice-small-gguf' },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: /run test/i }))
    await waitFor(() => {
      expect(canvas.getByText('The local recognition test completed successfully.')).toBeInTheDocument()
    })
  },
}

export const LocalFailure: Story = {
  args: { workMode: 'local', speechLanguage: 'uk' },
  parameters: {
    tauri: {
      commands: {
        get_test_audio_b64: () => testAudioBase64,
        run_asr_benchmark: () => { throw new Error('local model is unavailable') },
      },
      settings: { 'localAsr.modelId': 'nemotron-asr-streaming-0.6b-gguf' },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: /run test/i }))
    await waitFor(() => {
      expect(canvas.getByRole('alert')).toBeInTheDocument()
    })
  },
}
