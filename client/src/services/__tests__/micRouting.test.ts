import { describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => native.invoke(...args),
}))
vi.mock('../store', () => ({
  getSetting: (...args: unknown[]) => native.getSetting(...args),
  setSetting: (...args: unknown[]) => native.setSetting(...args),
}))

import {
  endpointKey,
  classifyActiveMic,
  planMicDevice,
  rememberWorkingMic,
  resolveMicPlan,
  type CaptureEndpoint,
} from '../micRouting'

const CABLE = 'CABLE Output (VB-Audio Virtual Cable)'
const INTEL = 'Microphone Array (Intel Smart Sound Technology)'
const HEADSET = 'Headset Microphone (Plantronics Blackwire 5220 Series)'

const endpoint = (name: string, extra: Partial<CaptureEndpoint> = {}): CaptureEndpoint => ({
  name,
  enumerator: extra.isVirtual ? 'ROOT' : 'USB',
  isVirtual: false,
  isDefault: false,
  isDefaultCommunications: false,
  ...extra,
})

const web = (deviceId: string, label: string, groupId = `group-${deviceId}`) => ({
  deviceId,
  groupId,
  label,
})

const virtualDefaultScene = {
  endpoints: [
    endpoint(CABLE, { isVirtual: true, isDefault: true }),
    endpoint(INTEL),
    endpoint(HEADSET, { isDefaultCommunications: true }),
  ],
  webDevices: [
    web('default', `Default - ${CABLE}`),
    web('communications', `Communications - ${HEADSET}`),
    web('cable', CABLE),
    web('intel', INTEL),
    web('headset', `${HEADSET} (047f:c053)`),
  ],
}

describe('planMicDevice', () => {
  it('uses the last confirmed real microphone before communications default', () => {
    const lastGood = planMicDevice({
      selectedMicId: '',
      lastGoodKey: endpointKey(INTEL),
      ...virtualDefaultScene,
    })
    const communications = planMicDevice({
      selectedMicId: '',
      lastGoodKey: '',
      ...virtualDefaultScene,
    })

    expect(lastGood).toMatchObject({ deviceId: 'intel', reason: 'virtual_avoided' })
    expect(communications).toMatchObject({ deviceId: 'headset', reason: 'virtual_avoided' })
  })

  it('uses the first reliably matched real input when no preferred input exists', () => {
    const plan = planMicDevice({
      selectedMicId: '',
      lastGoodKey: '',
      endpoints: [endpoint(CABLE, { isVirtual: true, isDefault: true }), endpoint(INTEL)],
      webDevices: [web('default', `Default - ${CABLE}`), web('cable', CABLE), web('intel', INTEL)],
    })

    expect(plan).toMatchObject({
      deviceId: 'intel',
      reason: 'virtual_avoided',
      avoidedName: CABLE,
      chosenName: INTEL,
    })
  })

  it('leaves every non-empty saved id unchanged, including legacy aliases and missing ids', () => {
    const endpoints = [endpoint(CABLE, { isVirtual: true, isDefault: true })]
    const webDevices = [web('cable', CABLE)]

    for (const selectedMicId of ['default', 'communications', 'cable', 'missing-device', ' missing-device ', ' ']) {
      expect(planMicDevice({ selectedMicId, endpoints, webDevices, lastGoodKey: '' })).toMatchObject({
        deviceId: selectedMicId,
        reason: 'explicit',
      })
    }
  })

  it('keeps following the native default when the WebView default target contradicts it', () => {
    const plan = planMicDevice({
      selectedMicId: '',
      lastGoodKey: endpointKey(INTEL),
      endpoints: [endpoint(CABLE, { isVirtual: true, isDefault: true }), endpoint(INTEL)],
      webDevices: [web('default', `Default - ${INTEL}`), web('intel', INTEL)],
    })

    expect(plan).toEqual({ deviceId: '', reason: 'default', avoidedName: '', chosenName: '' })
  })

  it.each([
    { kind: 'missing alias', hints: [] },
    { kind: 'hidden alias', hints: [web('default', '')] },
    { kind: 'unmatched alias', hints: [web('default', 'Default - Unknown')] },
    { kind: 'conflicting aliases', hints: [web('default', `Default - ${CABLE}`), web('default', `Default - ${INTEL}`)] },
    { kind: 'ambiguous label', hints: [web('default', `Default - ${CABLE}`)], sameName: endpoint(CABLE) },
  ])('does not switch away from an unconfirmed WebView default ($kind)', ({ hints, sameName }) => {
    const plan = planMicDevice({
      selectedMicId: '', lastGoodKey: '',
      endpoints: sameName ? [...virtualDefaultScene.endpoints, sameName] : virtualDefaultScene.endpoints,
      webDevices: [...hints, web('intel', INTEL)],
    })

    expect(plan.deviceId).toBe('')
  })

  it('resolves a localized default alias using its unambiguous device group', () => {
    const plan = planMicDevice({
      selectedMicId: '', lastGoodKey: '', endpoints: virtualDefaultScene.endpoints,
      webDevices: [web('default', `За замовчуванням - ${CABLE}`, 'cable-group'), web('cable', CABLE, 'cable-group'), web('intel', INTEL)],
    })

    expect(plan.deviceId).toBe('intel')
  })

  it('does not override the system route if the alias label and group point to different endpoints', () => {
    const plan = planMicDevice({
      selectedMicId: '', lastGoodKey: '', endpoints: virtualDefaultScene.endpoints,
      webDevices: [web('default', `Default - ${CABLE}`, 'intel-group'), web('intel', INTEL, 'intel-group')],
    })

    expect(plan.deviceId).toBe('')
  })

  it.each([
    { openedDefaultLabel: CABLE, deviceId: 'intel' },
    { openedDefaultLabel: INTEL, deviceId: '' },
    { openedDefaultLabel: '', deviceId: '' },
  ])('requires the opened default track to match the native virtual endpoint: $openedDefaultLabel', ({ openedDefaultLabel, deviceId }) => {
    const plan = planMicDevice({
      selectedMicId: '', lastGoodKey: '', endpoints: virtualDefaultScene.endpoints,
      webDevices: [web('intel', INTEL)],
      openedDefaultLabel,
    })

    expect(plan.deviceId).toBe(deviceId)
  })

  it('does not plan a retry when neither Windows nor WebView has a non-virtual alternative', () => {
    const plan = planMicDevice({
      selectedMicId: '', lastGoodKey: '',
      endpoints: [endpoint(CABLE, { isVirtual: true, isDefault: true })],
      webDevices: [web('default', `Default - ${CABLE}`), web('cable', CABLE)],
    })

    expect(plan).toMatchObject({ deviceId: '', reason: 'virtual_no_alternative' })
  })

  it('allows a permissioned retry when Windows sees a real input that WebView has not listed', () => {
    const plan = planMicDevice({
      selectedMicId: '', lastGoodKey: '', endpoints: virtualDefaultScene.endpoints,
      webDevices: [web('default', `Default - ${CABLE}`), web('cable', CABLE)],
    })

    expect(plan).toMatchObject({ deviceId: '', reason: 'unmapped' })
  })

  it('does not choose a label whose native classification is ambiguous', () => {
    expect(classifyActiveMic(INTEL, [endpoint(INTEL), endpoint(INTEL, { isVirtual: true })])).toBeNull()

    const plan = planMicDevice({
      selectedMicId: '',
      lastGoodKey: '',
      endpoints: [endpoint(CABLE, { isVirtual: true, isDefault: true }), endpoint(INTEL), endpoint(INTEL, { isVirtual: true })],
      webDevices: [web('intel', INTEL)],
    })

    expect(plan.reason).toBe('unmapped')
    expect(plan.deviceId).toBe('')
  })

  it('classifies the actually opened track only with complete native metadata', () => {
    expect(classifyActiveMic(CABLE, [endpoint(CABLE, { isVirtual: true })])).toBe(true)
    expect(classifyActiveMic(INTEL, [endpoint(INTEL)])).toBe(false)
    expect(classifyActiveMic(INTEL, [endpoint(INTEL, { enumerator: '' })])).toBeNull()
  })
})

describe('resolveMicPlan', () => {
  it('falls back to the existing default route when native endpoint IPC fails', async () => {
    native.invoke.mockRejectedValueOnce(new Error('native unavailable'))

    await expect(resolveMicPlan('')).resolves.toEqual({
      plan: { deviceId: '', reason: 'default', avoidedName: '', chosenName: '' },
      endpoints: [],
    })
    expect(native.invoke).toHaveBeenCalledWith('list_capture_endpoints')
  })

  it.each(['communications', ' '])('keeps a saved ID exact while still returning native metadata: %j', async (selectedMicId) => {
    const endpoints = [endpoint(CABLE, { isVirtual: true, isDefault: true })]
    native.invoke.mockReset().mockResolvedValue(endpoints)
    native.getSetting.mockResolvedValue('')

    await expect(resolveMicPlan(selectedMicId)).resolves.toEqual({
      plan: { deviceId: selectedMicId, reason: 'explicit', avoidedName: '', chosenName: '' },
      endpoints,
    })
  })

  it('does not rewrite the last-working source when it is already persisted', async () => {
    let saved = ''
    native.getSetting.mockReset().mockImplementation(async () => saved)
    native.setSetting.mockReset().mockImplementation(async (_key, value: string) => { saved = value })

    await rememberWorkingMic(INTEL)
    await rememberWorkingMic(INTEL)

    expect(native.setSetting).toHaveBeenCalledTimes(1)
    expect(saved).toBe('microphone array (intel smart sound technology)')
  })

  it('retries persisting the same source after a failed store write', async () => {
    let saved = 'previous microphone'
    native.getSetting.mockReset().mockImplementation(async () => saved)
    native.setSetting.mockReset().mockRejectedValueOnce(new Error('disk busy'))
      .mockImplementation(async (_key, value: string) => { saved = value })

    await rememberWorkingMic(HEADSET)
    expect(saved).toBe('previous microphone')

    await rememberWorkingMic(HEADSET)
    expect(saved).toBe('headset microphone (plantronics blackwire 5220 series)')
  })
})
