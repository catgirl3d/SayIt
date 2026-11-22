// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  listMicrophones: vi.fn(),
  refreshRecorderSettings: vi.fn(),
}))

const cable = 'CABLE Output'
const microphone = 'USB Microphone'
const endpoints = [
  { name: cable, enumerator: 'ROOT', isVirtual: true, isDefault: true, isDefaultCommunications: false },
  { name: microphone, enumerator: 'USB', isVirtual: false, isDefault: false, isDefaultCommunications: true },
]

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string) => command === 'list_capture_endpoints' ? endpoints : undefined,
}))
vi.mock('@/services/store', () => ({
  getSetting: (...args: unknown[]) => mocks.getSetting(...args),
  setSetting: (...args: unknown[]) => mocks.setSetting(...args),
}))
vi.mock('@/services/audio', () => ({
  listMicrophones: (...args: unknown[]) => mocks.listMicrophones(...args),
}))
vi.mock('@/services/recorder', () => ({
  refreshRecorderSettings: (...args: unknown[]) => mocks.refreshRecorderSettings(...args),
}))
vi.mock('@/services/waveform', () => ({
  drawBars: vi.fn(),
  resetWaveform: vi.fn(),
}))

import AudioSettingsPage from '../AudioSettingsPage'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const input = (deviceId: string, label: string): MediaDeviceInfo => ({
  deviceId, groupId: `group-${deviceId}`, kind: 'audioinput', label, toJSON: () => ({}),
})
const visibleInputs = (microphoneId: string) => [input('default', `Default - ${cable}`), input(microphoneId, microphone)]

describe('AudioSettingsPage microphone test', () => {
  let previousMediaDevices: PropertyDescriptor | undefined

  beforeEach(() => {
    previousMediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
    mocks.getSetting.mockReset().mockImplementation(async (key: string, fallback: unknown) => {
      if (key === 'selectedMic') return ''
      return fallback
    })
    mocks.setSetting.mockReset().mockResolvedValue(undefined)
    mocks.listMicrophones.mockReset().mockResolvedValue(visibleInputs('physical-device'))
    mocks.refreshRecorderSettings.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    if (previousMediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', previousMediaDevices)
    } else {
      delete (navigator as Omit<Navigator, 'mediaDevices'> & { mediaDevices?: MediaDevices }).mediaDevices
    }
  })

  it('opens a newly enumerated input instead of the unplugged device shown when settings opened', async () => {
    const pendingStream = deferred<MediaStream>()
    const getUserMedia = vi.fn(() => pendingStream.promise)
    const track = { stop: vi.fn() }
    const stream = { getTracks: () => [track] } as unknown as MediaStream
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia, enumerateDevices: async () => visibleInputs('replacement-device') },
    })

    const view = render(<AudioSettingsPage />)
    await screen.findByText(/SayIt is using USB Microphone for dictation/)

    fireEvent.click(screen.getByRole('button', { name: 'Test microphone' }))
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledWith({
      audio: { deviceId: { exact: 'replacement-device' } },
    }))

    await act(async () => {
      // Unmount while getUserMedia is still pending; the late result belongs to this attempt only.
      view.unmount()
      pendingStream.resolve(stream)
    })

    expect(track.stop).toHaveBeenCalledTimes(1)
  })

  it('uses the opened default to retry once when permission exposes the input labels', async () => {
    let probeOpen = false
    const nextStream = deferred<MediaStream>()
    const probeTrack = { label: cable, stop: () => { probeOpen = false } }
    const probe = { getTracks: () => [probeTrack], getAudioTracks: () => [probeTrack] } as unknown as MediaStream
    const getUserMedia = vi.fn(async ({ audio }: MediaStreamConstraints) => {
      if (audio === true) {
        probeOpen = true
        return probe
      }
      expect(probeOpen).toBe(false)
      return nextStream.promise
    })
    mocks.listMicrophones.mockResolvedValue([])
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia,
        enumerateDevices: async () => probeOpen ? visibleInputs('replacement-device') : [input('default', '')],
      },
    })

    const view = render(<AudioSettingsPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Test microphone' }))

    await waitFor(() => expect(getUserMedia.mock.calls).toEqual([
      [{ audio: true }],
      [{ audio: { deviceId: { exact: 'replacement-device' } } }],
    ]))
    view.unmount()
  })
})
