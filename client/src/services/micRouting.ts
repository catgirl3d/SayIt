import { invoke } from '@tauri-apps/api/core'
import { addRuntimeEvent } from './debugLog'
import { cleanActiveMicLabel } from './recorder/micSourceReminder'
import { getSetting, setSetting } from './store'

/** A capture endpoint reported by the native audio layer. */
export interface CaptureEndpoint {
  name: string
  enumerator: string
  isVirtual: boolean
  isDefault: boolean
  isDefaultCommunications: boolean
}

export type MicPlanReason =
  | 'explicit'
  | 'default'
  | 'virtual_avoided'
  | 'virtual_no_alternative'
  | 'unmapped'

export interface MicPlan {
  /** The device id passed to getUserMedia; an empty string follows the system default. */
  deviceId: string
  reason: MicPlanReason
  avoidedName: string
  chosenName: string
}

const LAST_GOOD_MIC_KEY = 'micLastGoodDevice'
type MicEndpoint = Pick<MediaDeviceInfo, 'deviceId' | 'label' | 'groupId'>

/** Normalize only the label syntax already used by the source reminder. */
export function endpointKey(label: string): string {
  return cleanActiveMicLabel(label)
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase()
}

function isPseudoInputDevice(deviceId: string): boolean {
  const id = deviceId.trim().toLocaleLowerCase()
  return !id || id === 'default' || id === 'communications'
}

function nativeMatches(label: string, endpoints: CaptureEndpoint[]): CaptureEndpoint[] {
  const key = endpointKey(label)
  if (!key) return []
  return endpoints.filter((endpoint) => endpointKey(endpoint.name) === key)
}

function realWebInputs(devices: MicEndpoint[]): MicEndpoint[] {
  return devices.filter((device) => !isPseudoInputDevice(device.deviceId) && device.label.trim().length > 0)
}

function uniqueByLabel(devices: MicEndpoint[]): MicEndpoint[] {
  const counts = new Map<string, number>()
  for (const device of devices) {
    const key = endpointKey(device.label)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return devices.filter((device) => counts.get(endpointKey(device.label)) === 1)
}

function nativeDefault(endpoints: CaptureEndpoint[]): CaptureEndpoint | null {
  const defaults = endpoints.filter((endpoint) => endpoint.isDefault)
  return defaults.length === 1 ? defaults[0] : null
}

/**
 * Return the plan for a controlled snapshot. This function never invokes IPC and never opens a
 * stream, which keeps the selection rule independent from the capture lifecycle.
 */
export function planMicDevice(input: {
  selectedMicId: string
  webDevices: MicEndpoint[]
  endpoints: CaptureEndpoint[]
  lastGoodKey: string
  /** On retry, use the route actually opened by an unconstrained capture. */
  openedDefaultLabel?: string
}): MicPlan {
  // Every non-empty value is an explicit persisted choice, including legacy pseudo ids and ids
  // that are currently absent from enumerateDevices().
  if (input.selectedMicId) {
    return { deviceId: input.selectedMicId, reason: 'explicit', avoidedName: '', chosenName: '' }
  }

  const followDefault = followDefaultPlan()
  const defaultEndpoint = nativeDefault(input.endpoints)
  if (!defaultEndpoint || !defaultEndpoint.isVirtual || !defaultEndpoint.enumerator.trim()) return followDefault

  const unmapped: MicPlan = { ...followDefault, reason: 'unmapped', avoidedName: defaultEndpoint.name }
  const named = realWebInputs(input.webDevices)
  if (input.openedDefaultLabel !== undefined) {
    const hits = nativeMatches(input.openedDefaultLabel, input.endpoints)
    if (hits.length !== 1 || hits[0] !== defaultEndpoint) return followDefault
  } else {
    const hints = input.webDevices.filter((device) => device.deviceId === 'default')
    if (hints.length > 1) return followDefault
    const hint = hints[0]
    if (!hint) return unmapped

    // A localized alias may not match by name. Its group can identify its concrete input instead.
    const labelHits = nativeMatches(hint.label, input.endpoints)
    const group = hint.groupId.trim()
    const groupInputs = group ? named.filter((device) => device.groupId.trim() === group) : []
    const groupHits = groupInputs.length === 1 ? nativeMatches(groupInputs[0].label, input.endpoints) : []
    if ([labelHits, groupHits].some((hits) => hits.length > 1 || (hits.length === 1 && hits[0] !== defaultEndpoint))) {
      return followDefault
    }
    if (!labelHits.length && !groupHits.length) return unmapped
  }

  const candidates = uniqueByLabel(named).filter((device) => classifyActiveMic(device.label, input.endpoints) === false)
  if (candidates.length === 0) {
    return input.endpoints.every((endpoint) => endpoint.isVirtual && endpoint.enumerator.trim())
      ? { ...unmapped, reason: 'virtual_no_alternative' }
      : unmapped
  }

  const lastGoodKey = endpointKey(input.lastGoodKey)
  const lastGood = lastGoodKey
    ? candidates.filter((device) => endpointKey(device.label) === lastGoodKey)
    : []

  const communicationDefaults = input.endpoints.filter((endpoint) => endpoint.isDefaultCommunications)
  const communicationKeys = new Set(
    communicationDefaults.length === 1
      ? communicationDefaults
        .filter((endpoint) => endpoint.enumerator.trim() && !endpoint.isVirtual)
        .map((endpoint) => endpointKey(endpoint.name))
      : [],
  )
  const communications = candidates.filter((device) => communicationKeys.has(endpointKey(device.label)))
  const chosen = lastGood.length === 1
    ? lastGood[0]
    : communications.length === 1
      ? communications[0]
      : candidates[0]

  return {
    deviceId: chosen.deviceId,
    reason: 'virtual_avoided',
    avoidedName: defaultEndpoint.name,
    chosenName: cleanActiveMicLabel(chosen.label),
  }
}

function asEndpointList(raw: unknown): CaptureEndpoint[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is CaptureEndpoint => (
    !!item
    && typeof item === 'object'
    && typeof (item as CaptureEndpoint).name === 'string'
    && typeof (item as CaptureEndpoint).enumerator === 'string'
    && typeof (item as CaptureEndpoint).isVirtual === 'boolean'
    && typeof (item as CaptureEndpoint).isDefault === 'boolean'
    && typeof (item as CaptureEndpoint).isDefaultCommunications === 'boolean'
  ))
}

async function listCaptureEndpoints(): Promise<CaptureEndpoint[]> {
  try {
    return asEndpointList(await invoke('list_capture_endpoints'))
  } catch (error) {
    addRuntimeEvent('warn', 'audio', 'Could not query Windows microphone routes', { error: String(error) })
    return []
  }
}

async function snapshotWebInputs(): Promise<MicEndpoint[]> {
  try {
    const list = await navigator.mediaDevices.enumerateDevices()
    return list.filter((device) => device.kind === 'audioinput')
  } catch (error) {
    addRuntimeEvent('warn', 'audio', 'Could not list WebView microphone inputs', { error: String(error) })
    return []
  }
}

/** Resolve the input without requesting permission or opening a media stream. */
export async function resolveMicPlan(
  selectedMicId: string,
  options: { webDevices?: MicEndpoint[]; openedDefaultLabel?: string } = {},
): Promise<{ plan: MicPlan; endpoints: CaptureEndpoint[] }> {
  const endpoints = await listCaptureEndpoints()
  if (selectedMicId) {
    return {
      plan: planMicDevice({ selectedMicId, webDevices: [], endpoints: [], lastGoodKey: '' }),
      endpoints,
    }
  }

  const defaultEndpoint = nativeDefault(endpoints)
  if (!defaultEndpoint?.isVirtual || !defaultEndpoint.enumerator.trim()) {
    return { plan: followDefaultPlan(), endpoints }
  }

  const [webDevices, lastGoodKey] = await Promise.all([
    options.webDevices ?? snapshotWebInputs(),
    getSetting<string>(LAST_GOOD_MIC_KEY, '').catch(() => ''),
  ])

  return {
    plan: planMicDevice({
      selectedMicId: '',
      webDevices,
      endpoints,
      lastGoodKey: String(lastGoodKey || ''),
      openedDefaultLabel: options.openedDefaultLabel,
    }),
    endpoints,
  }
}

function followDefaultPlan(): MicPlan {
  return { deviceId: '', reason: 'default', avoidedName: '', chosenName: '' }
}

/** Classify the endpoint that a successfully opened track represents. */
export function classifyActiveMic(label: string, endpoints: CaptureEndpoint[]): boolean | null {
  const hits = nativeMatches(label, endpoints)
  if (hits.length !== 1 || !hits[0].enumerator.trim()) return null
  return hits[0].isVirtual
}

/** Store a confirmed source once per change; leave failed writes retryable. */
export async function rememberWorkingMic(label: string): Promise<void> {
  const key = endpointKey(label)
  if (!key) return
  try {
    const lastGood = await getSetting<string>(LAST_GOOD_MIC_KEY, '')
    if (lastGood !== key) await setSetting(LAST_GOOD_MIC_KEY, key)
  } catch (error) {
    addRuntimeEvent('warn', 'audio', 'Could not remember the working microphone', { error: String(error) })
  }
}
