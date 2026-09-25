import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import MicrophoneSection from '@/features/settings/MicrophoneSection'
import { Select } from '../select'

const hookStateOverrides = vi.hoisted(() => ({ values: [] as unknown[] }))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: <T,>(initialValue: T) => {
      if (hookStateOverrides.values.length > 0) {
        return [hookStateOverrides.values.shift() as T, () => {}]
      }
      return actual.useState(initialValue)
    },
    useEffect: () => undefined,
    useLayoutEffect: () => undefined,
  }
})

vi.mock('react-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-dom')>()
  return { ...actual, createPortal: (children: React.ReactNode) => children }
})

vi.mock('@/i18n/useT', () => ({ useT: () => (key: string) => key }))

afterEach(() => {
  hookStateOverrides.values = []
  vi.unstubAllGlobals()
})

describe('Select rendered accessibility markup', () => {
  it('labels the trigger and exposes its closed state', () => {
    const markup = renderToStaticMarkup(createElement(Select, {
      value: 'default',
      onChange: () => {},
      labelledBy: 'mic-select-label',
      options: [{ value: 'default', label: 'System default' }],
    }))

    expect(markup).toContain('aria-labelledby="mic-select-label"')
    expect(markup).not.toContain('aria-haspopup="listbox"')
    expect(markup).toContain('aria-expanded="false"')
  })

  it('exposes the open state and only renders explicitly supplied option titles', () => {
    hookStateOverrides.values = [true, { top: 100, left: 20, width: 240, maxHeight: 180 }]
    vi.stubGlobal('document', { body: {} })

    const markup = renderToStaticMarkup(createElement(Select, {
      value: 'long',
      onChange: () => {},
      labelledBy: 'mic-select-label',
      options: [
        { value: 'long', label: 'USB microphone', title: 'USB microphone with full model suffix' },
        { value: 'short', label: 'Laptop microphone' },
      ],
    }))

    expect(markup).toContain('aria-labelledby="mic-select-label"')
    expect(markup).not.toContain('aria-haspopup="listbox"')
    expect(markup).toContain('aria-expanded="true"')
    expect(markup).toContain('title="USB microphone with full model suffix"')
    expect(markup).not.toContain('title="Laptop microphone"')
  })

  it('associates the microphone label and keeps the full physical device name available', () => {
    const mic = {
      deviceId: 'device-123',
      groupId: 'group-123',
      kind: 'audioinput',
      label: 'Long USB microphone model with identifying suffix (1234:abcd)',
      toJSON: () => ({}),
    } as MediaDeviceInfo

    const markup = renderToStaticMarkup(createElement(MicrophoneSection, {
      mics: [mic],
      selectedMic: mic.deviceId,
      testing: false,
      volumeLevel: 'idle',
      micBoost: '3',
      ready: true,
      animate: false,
      onCanvasRef: () => {},
      onMicChange: () => {},
      onTestMic: () => {},
      onMicBoostChange: () => {},
    }))

    expect(markup).toContain('id="mic-select-label"')
    expect(markup).toContain('aria-labelledby="mic-select-label"')
    expect(markup).toContain('title="Long USB microphone model with identifying suffix (1234:abcd)"')
  })
})
