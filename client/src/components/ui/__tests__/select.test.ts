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

vi.mock('@/i18n/useT', () => ({
  useT: () => (key: string, params?: Record<string, string | number>) =>
    params ? `${key}(${Object.values(params).join(', ')})` : key,
}))

function microphone(deviceId: string, label: string, groupId = ''): MediaDeviceInfo {
  return { deviceId, label, groupId, kind: 'audioinput', toJSON: () => ({}) } as MediaDeviceInfo
}

function renderMicPicker(mics: MediaDeviceInfo[], selectedMic: string): string {
  hookStateOverrides.values = [true, { top: 100, left: 20, width: 240, maxHeight: 180 }]
  vi.stubGlobal('document', { body: {} })

  return renderToStaticMarkup(createElement(MicrophoneSection, {
    mics,
    selectedMic,
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
}

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

  it('renders a secondary part behind a decorative divider and keeps the full text as the title', () => {
    hookStateOverrides.values = [true, { top: 100, left: 20, width: 240, maxHeight: 180 }]
    vi.stubGlobal('document', { body: {} })

    const markup = renderToStaticMarkup(createElement(Select, {
      value: 'deepgram',
      onChange: () => {},
      options: [
        { value: 'deepgram', label: 'Deepgram', secondary: 'nova-3' },
        { value: 'openai', label: 'OpenAI' },
      ],
    }))

    expect(markup).toContain('title="Deepgram · nova-3"')
    const cleaned = markup.replace(/<!--.*?-->/g, '')
    expect(cleaned).toContain('<span aria-hidden="true" class="mx-1.5 inline-block h-3.5 w-px bg-border align-middle"></span>')
    // The divider is visual only; the screen-reader dot keeps the plain "label · secondary" text.
    expect(cleaned).toMatch(/<span class="sr-only">·<\/span>/)
    expect(cleaned).toMatch(/<span class="text-muted-foreground">nova-3<\/span>/)
    expect(markup).not.toContain('title="OpenAI"')
  })

  it('renders one heading per run of consecutive options that share a group', () => {
    hookStateOverrides.values = [true, { top: 100, left: 20, width: 240, maxHeight: 180 }]
    vi.stubGlobal('document', { body: {} })

    // The selected label also renders in the trigger, ahead of the dropdown, so select an
    // ungrouped option to keep every other label unique to the list.
    const markup = renderToStaticMarkup(createElement(Select, {
      value: 'delta',
      onChange: () => {},
      options: [
        { value: 'alpha', label: 'Alpha', group: 'First group' },
        { value: 'beta', label: 'Beta', group: 'First group' },
        { value: 'gamma', label: 'Gamma', group: 'Second group' },
        { value: 'delta', label: 'Delta' },
      ],
    }))

    expect(markup.match(/First group/g)).toHaveLength(1)
    expect(markup.match(/Second group/g)).toHaveLength(1)
    expect(markup.indexOf('First group')).toBeLessThan(markup.indexOf('Alpha'))
    expect(markup.indexOf('Second group')).toBeGreaterThan(markup.indexOf('Beta'))
    expect(markup.indexOf('Second group')).toBeLessThan(markup.indexOf('Gamma'))
  })

  it('renders no group headings for options without a group', () => {
    hookStateOverrides.values = [true, { top: 100, left: 20, width: 240, maxHeight: 180 }]
    vi.stubGlobal('document', { body: {} })

    const markup = renderToStaticMarkup(createElement(Select, {
      value: 'alpha',
      onChange: () => {},
      options: [{ value: 'alpha', label: 'Alpha' }, { value: 'beta', label: 'Beta' }],
    }))

    expect(markup).not.toContain('uppercase')
  })

  it('renders the open dropdown on the popover surface', () => {
    hookStateOverrides.values = [true, { top: 100, left: 20, width: 240, maxHeight: 180 }]
    vi.stubGlobal('document', { body: {} })

    const markup = renderToStaticMarkup(createElement(Select, {
      value: 'default',
      onChange: () => {},
      labelledBy: 'mic-select-label',
      options: [{ value: 'default', label: 'System default' }],
    }))

    expect(markup).toContain('bg-popover')
    expect(markup).not.toContain('bg-card')
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

describe('Microphone picker', () => {
  it('shows one default with a uniquely matched device and labels a distinct communications route', () => {
    const markup = renderMicPicker([
      microphone('default', 'Default - USB Mic', 'usb'),
      microphone('communications', 'Communications - Headset', 'headset'),
      microphone('usb-1', 'USB Mic', 'usb'),
      microphone('usb-1', 'USB Mic', 'usb'),
      microphone('headset-1', 'Headset', 'headset'),
      microphone('secret-1', ''),
      microphone('', ''),
    ], '')

    expect(markup).toContain('mic.systemDefaultWithDevice(USB Mic)')
    expect(markup).toContain('mic.communicationsDefaultWithDevice(Headset)')
    expect(markup).toContain('title="Communications - Headset"')
    expect(markup.match(/title="USB Mic"/g)).toHaveLength(1)
    expect(markup).toContain('mic.unnamed(secret-1)')
    expect(markup).not.toContain('title="Default - USB Mic"')
    expect(markup).not.toContain('mic.unnamed()')
  })

  it('hides the communications alias when it resolves to the system-default device', () => {
    const markup = renderMicPicker([
      microphone('default', 'Default - USB Mic', 'usb'),
      microphone('communications', 'Communications - USB Mic', 'usb'),
      microphone('usb-1', 'USB Mic', 'usb'),
    ], '')

    expect(markup).toContain('mic.systemDefaultWithDevice(USB Mic)')
    expect(markup).not.toContain('Communications - USB Mic')
    expect(markup).not.toContain('mic.communicationsDefault')
  })

  it('hides the communications alias when groups are absent but cleaned labels match', () => {
    const markup = renderMicPicker([
      microphone('default', 'Default - Studio Mic'),
      microphone('communications', 'Communications - Studio Mic'),
      microphone('studio-1', 'Studio Mic'),
    ], '')

    expect(markup).not.toContain('Communications - Studio Mic')
  })

  it('keeps a saved communications alias visible even when it resolves to the system-default device', () => {
    const markup = renderMicPicker([
      microphone('default', 'Default - USB Mic', 'usb'),
      microphone('communications', 'Communications - USB Mic', 'usb'),
      microphone('usb-1', 'USB Mic', 'usb'),
    ], 'communications')

    expect(markup).toContain('mic.communicationsDefaultWithDevice(USB Mic)')
    expect(markup).toContain('title="Communications - USB Mic"')
  })

  it('keeps a saved browser default alias distinct from the blank system default', () => {
    const markup = renderMicPicker([
      microphone('default', 'Default - USB Mic', 'usb'),
      microphone('usb-1', 'USB Mic', 'usb'),
    ], 'default')

    expect(markup).toContain('mic.savedDefault')
    expect(markup).toContain('mic.systemDefaultWithDevice(USB Mic)')
    expect(markup).not.toContain('title="Default - USB Mic"')
  })

  it('treats noncanonical opaque IDs as distinct devices rather than browser aliases', () => {
    const markup = renderMicPicker([
      microphone('default', 'Default - Studio Mic', 'studio'),
      microphone('DEFAULT', 'External Mic', 'external'),
      microphone('COMMUNICATIONS', 'Studio Mic', 'studio'),
    ], 'DEFAULT')

    expect(markup).toContain('title="External Mic"')
    expect(markup).not.toContain('mic.savedDefault')
    expect(markup).toContain('mic.systemDefaultWithDevice(Studio Mic)')
  })

  it('still resolves a physical device when the same browser default is listed twice', () => {
    const markup = renderMicPicker([
      microphone('default', 'Default - USB Mic', 'usb'),
      microphone('default', 'Default - USB Mic', 'usb'),
      microphone('usb-1', 'USB Mic', 'usb'),
    ], '')

    expect(markup).toContain('mic.systemDefaultWithDevice(USB Mic)')
    expect(markup).not.toContain('title="Default - USB Mic"')
  })

  it('keeps a saved ID visible when the current enumeration does not contain it', () => {
    const markup = renderMicPicker([microphone('usb-1', 'USB Mic')], 'old-device')

    expect(markup).toContain('mic.savedNotListed')
    expect(markup).not.toContain('ui.selectPlaceholder')
  })
})
