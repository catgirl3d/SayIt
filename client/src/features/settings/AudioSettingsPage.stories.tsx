import type { Meta, StoryObj } from '@storybook/react-vite'
import AudioSettingsPage from './AudioSettingsPage'

const meta = {
  title: 'settings/AudioSettingsPage',
  component: AudioSettingsPage,
  parameters: {
    tauri: {
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
        groupId: 'studio-group',
        kind: 'audioinput',
        label: 'Default USB microphone',
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
