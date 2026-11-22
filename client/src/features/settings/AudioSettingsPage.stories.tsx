import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, within } from 'storybook/test'
import AudioSettingsPage from './AudioSettingsPage'

const virtualDefaultEndpoints = [
  {
    name: 'CABLE Output (VB-Audio Virtual Cable)',
    enumerator: 'ROOT',
    isVirtual: true,
    isDefault: true,
    isDefaultCommunications: false,
  },
  {
    name: 'USB Studio Microphone',
    enumerator: 'USB',
    isVirtual: false,
    isDefault: false,
    isDefaultCommunications: true,
  },
]

const meta = {
  title: 'settings/AudioSettingsPage',
  component: AudioSettingsPage,
  parameters: {
    tauri: {
      commands: {
        list_capture_endpoints: () => virtualDefaultEndpoints,
      },
      settings: {
        selectedMic: 'studio-mic',
        micBoost: 'auto',
        muteSystemAudioWhileRecording: true,
        readySoundEnabled: false,
      },
    },
  },
  beforeEach: () => {
    const previousDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
    const devices: MediaDeviceInfo[] = [
      {
        deviceId: 'default',
        groupId: 'virtual-group',
        kind: 'audioinput',
        label: 'Default - CABLE Output (VB-Audio Virtual Cable)',
        toJSON: () => ({}),
      } as MediaDeviceInfo,
      {
        deviceId: 'virtual-cable',
        groupId: 'virtual-group',
        kind: 'audioinput',
        label: 'CABLE Output (VB-Audio Virtual Cable)',
        toJSON: () => ({}),
      } as MediaDeviceInfo,
      {
        deviceId: 'studio-mic',
        groupId: 'studio-group',
        kind: 'audioinput',
        label: 'USB Studio Microphone',
        toJSON: () => ({}),
      } as MediaDeviceInfo,
    ]

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        enumerateDevices: async () => devices,
      } as unknown as MediaDevices,
    })

    return () => {
      if (previousDescriptor) {
        Object.defineProperty(navigator, 'mediaDevices', previousDescriptor)
      } else {
        delete (navigator as Omit<Navigator, 'mediaDevices'> & { mediaDevices?: MediaDevices }).mediaDevices
      }
    }
  },
} satisfies Meta<typeof AudioSettingsPage>

export default meta
type Story = StoryObj<typeof meta>

export const Configured: Story = {}

export const VirtualDefaultAuto: Story = {
  parameters: {
    tauri: {
      commands: {
        list_capture_endpoints: () => virtualDefaultEndpoints,
      },
      settings: {
        selectedMic: '',
        micBoost: 'auto',
        muteSystemAudioWhileRecording: false,
        readySoundEnabled: true,
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText(/Windows default is the virtual endpoint/i)).toBeVisible()
    await expect(canvas.getByText(/using USB Studio Microphone for dictation/i)).toBeVisible()
  },
}
