import { beforeEach, describe, it, expect, vi } from 'vitest'
import {
  ASR_ACTIVE_PROFILE_KEY,
  ASR_AUTO_CREATED_KEY,
  ASR_PROFILES_KEY,
  loadActiveAsrProfile,
  loadAsrProfiles,
  saveAsrProfileChecks,
  saveAsrProfiles,
  topUpProfiles,
} from '../asrProfileStore'
import { emptyAsrProfile, type AsrCheck, type AsrProfile } from '../asrProviderCatalog'
import en from '@/i18n/locales/en.json'
import uk from '@/i18n/locales/uk.json'

const storedSettings = vi.hoisted(() => new Map<string, unknown>())
const delayedWrites = vi.hoisted(() => new Map<string, Promise<void>>())
const failedWrites = vi.hoisted(() => new Set<string>())
const writeStarted = vi.hoisted(() => new Map<string, () => void>())

vi.mock('@/services/store', () => ({
  getSetting: vi.fn(async (key: string, fallback: unknown) => storedSettings.get(key) ?? fallback),
  setSetting: vi.fn(async (key: string, value: unknown) => {
    writeStarted.get(key)?.()
    if (failedWrites.has(key)) throw new Error(`write failed: ${key}`)
    const delay = delayedWrites.get(key)
    if (delay) await delay
    storedSettings.set(key, structuredClone(value))
  }),
}))

beforeEach(() => {
  storedSettings.clear()
  delayedWrites.clear()
  failedWrites.clear()
  writeStarted.clear()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function creds(over: Record<string, unknown> = {}) {
  return {
    apiKey: 'KEY', otherKey: '', appId: '', console: 'new' as const,
    workspaceId: '', omniPrompt: 'P', ...over,
  }
}

function profile(provider: string, over: Partial<AsrProfile> = {}): AsrProfile {
  return { ...emptyAsrProfile(provider), ...over }
}

describe('topUpProfiles', () => {
  /**
   * 这条是回归测试。第一版迁移按「每个平台一份」建档案，千问平台下 4 个变体
   * （一次性 / 流式 / 两个 Omni）被压成 1 张卡，用户升级后发现服务少了 3 个。
   */
  it('一个平台填了密钥，就为该平台下每个服务各建一份', () => {
    const r = topUpProfiles([], { qwen: creds({ apiKey: 'sk-1' }) })
    expect(r.profiles.map((p) => p.provider)).toEqual([
      'qwen_audio_stream', 'qwen', 'qwen_realtime', 'qwen_omni_35_plus', 'qwen_omni_35_flash',
      'qwen_omni_38_realtime',
    ])
    expect(r.added).toHaveLength(6)
  })

  it('三个平台都有密钥时补出全部 7 个服务', () => {
    const r = topUpProfiles([], {
      doubao: creds(), qwen: creds({ apiKey: 'sk-1' }), mimo: creds(),
    })
    expect(r.profiles).toHaveLength(8)
  })

  it('没填密钥的平台不建卡 —— 新用户应看到空状态引导，而不是一堆空卡', () => {
    expect(topUpProfiles([], {}).profiles).toEqual([])
    expect(topUpProfiles([], { qwen: creds({ apiKey: '   ' }) }).profiles).toEqual([])
    expect(topUpProfiles([], { mimo: creds({ apiKey: '', otherKey: '' }) }).profiles).toEqual([])
  })

  /**
   * 真实场景回归：第一版迁移只建了 doubao_v2 / qwen_realtime / mimo 三份，
   * 补齐必须把千问平台下其余几个加上，且不动已有的那份。
   */
  it('在第一版迁移的结果上补齐千问剩下几个', () => {
    const existing = [profile('doubao_v2'), profile('qwen_realtime'), profile('mimo')]
    const r = topUpProfiles(existing, {
      doubao: creds(), qwen: creds({ apiKey: 'sk-1' }), mimo: creds(),
    })
    expect(r.added).toEqual([
      'qwen_audio_stream', 'qwen', 'qwen_omni_35_plus', 'qwen_omni_35_flash', 'qwen_omni_38_realtime',
    ])
    expect(r.profiles).toHaveLength(8)
    expect(r.profiles.slice(0, 3)).toEqual(existing) // 原有三份原样不动
  })

  it('只补缺的，已有档案原样不动（对已经自己建过卡的用户幂等）', () => {
    const existing = [profile('qwen', { apiKey: 'MY-OWN' })]
    const r = topUpProfiles(existing, { qwen: creds({ apiKey: 'sk-1' }) })
    expect(r.profiles).toHaveLength(6)
    expect(r.profiles[0]).toBe(existing[0]) // 同一个对象，没被替换
    expect(r.profiles.filter((p) => p.provider === 'qwen')).toHaveLength(1)
  })

  it('重复调用不会越补越多', () => {
    const once = topUpProfiles([], { doubao: creds() })
    const twice = topUpProfiles(once.profiles, { doubao: creds() })
    expect(twice.profiles).toEqual(once.profiles)
    expect(twice.added).toEqual([])
  })

  /**
   * 用户主动删掉的卡不该被"救回来"。
   * 记「补过谁」而不是「补完了」，就是为了同时满足自愈与尊重删除这两件事。
   */
  it('已经自动补过又被删掉的服务不再重建', () => {
    const r = topUpProfiles([], { qwen: creds({ apiKey: 'sk-1' }) }, ['qwen', 'qwen_omni_35_flash'])
    expect(r.added).toEqual([
      'qwen_audio_stream', 'qwen_realtime', 'qwen_omni_35_plus', 'qwen_omni_38_realtime',
    ])
  })

  it('豆包的控制台代次与两代密钥都带过去', () => {
    const { profiles: [p] } = topUpProfiles([], {
      doubao: creds({ apiKey: 'TOKEN', otherKey: 'APPKEY', appId: '123', console: 'legacy' }),
    })
    expect(p.console).toBe('legacy')
    expect(p.apiKey).toBe('TOKEN')
    expect(p.otherKey).toBe('APPKEY')
    expect(p.appId).toBe('123')
  })

  it('只有豆包侧填了 App ID + Access Token（apiKey 为空）也算有密钥', () => {
    // 旧版控制台用户可能只有 otherKey 那一侧有值，不能因此判成"没配置"
    const r = topUpProfiles([], { doubao: creds({ apiKey: '', otherKey: 'APPKEY' }) })
    expect(r.profiles).toHaveLength(1)
  })

  it('System Prompt 只给 Omni 服务，普通识别服务不带', () => {
    const { profiles } = topUpProfiles([], { qwen: creds({ apiKey: 'sk-1', omniPrompt: 'MY PROMPT' }) })
    const omni = profiles.filter((p) => p.provider.includes('omni'))
    const plain = profiles.filter((p) => !p.provider.includes('omni'))
    expect(omni.every((p) => p.omniPrompt === 'MY PROMPT')).toBe(true)
    expect(plain.every((p) => p.omniPrompt === '')).toBe(true)
  })

  it('业务空间 ID 跟着千问平台走', () => {
    const { profiles } = topUpProfiles([], { qwen: creds({ apiKey: 'sk-1', workspaceId: 'ws-abc' }) })
    expect(profiles.every((p) => p.workspaceId === 'ws-abc')).toBe(true)
  })

  it('补出来的档案 id 互不相同', () => {
    const { profiles } = topUpProfiles([], { doubao: creds(), qwen: creds(), mimo: creds() })
    expect(new Set(profiles.map((p) => p.id)).size).toBe(profiles.length)
  })
})

describe('ASR profile persistence', () => {
  it('finishes legacy profile migration without re-entering the serialized queue', async () => {
    storedSettings.set('cloudAsr.provider', 'openai_transcribe')
    storedSettings.set('cloudAsr.openai.apiKey', 'migrated-openai-key')

    const state = await loadAsrProfiles()

    expect(state.profiles).toHaveLength(1)
    expect(state.profiles[0]).toMatchObject({
      provider: 'openai_transcribe',
      apiKey: 'migrated-openai-key',
      model: 'gpt-transcribe',
    })
    expect(state.activeId).toBe(state.profiles[0].id)
    expect(storedSettings.get(ASR_PROFILES_KEY)).toEqual(state.profiles)
  })

  it('tops up the 3.8 profile once without changing the active profile', async () => {
    const active = profile('qwen_omni_35_flash', {
      id: 'qwen35-account-a',
      apiKey: 'profile-key',
    })
    storedSettings.set(ASR_PROFILES_KEY, [active])
    storedSettings.set(ASR_ACTIVE_PROFILE_KEY, active.id)
    storedSettings.set('cloudAsr.qwen.apiKey', 'shared-qwen-key')

    const firstLoad = await loadAsrProfiles()
    expect(firstLoad.activeId).toBe(active.id)
    expect(firstLoad.profiles.find(({ provider }) => provider === 'qwen_omni_38_realtime')).toMatchObject({
      provider: 'qwen_omni_38_realtime',
      model: 'qwen3.8-omni-flash-realtime',
      apiKey: 'shared-qwen-key',
    })
    expect(storedSettings.get(ASR_AUTO_CREATED_KEY)).toContain('qwen_omni_38_realtime')

    const secondLoad = await loadAsrProfiles()
    expect(secondLoad.activeId).toBe(active.id)
    expect(secondLoad.profiles.filter(({ provider }) => provider === 'qwen_omni_38_realtime')).toHaveLength(1)
    expect(secondLoad.profiles.filter(({ provider }) => provider.startsWith('qwen_omni'))).toHaveLength(3)
  })

  it('loads the selected same-vendor profile with its own key and model', async () => {
    const first = {
      ...emptyAsrProfile('openai_transcribe'),
      id: 'openai-account-a',
      apiKey: 'key-account-a',
      model: 'gpt-transcribe',
    } as AsrProfile
    const second = {
      ...emptyAsrProfile('openai_transcribe'),
      id: 'openai-account-b',
      apiKey: 'key-account-b',
      model: 'whisper-1',
    } as AsrProfile

    await saveAsrProfiles({ profiles: [first, second], activeId: first.id })
    const firstState = await loadAsrProfiles()
    expect(firstState.profiles.find((profile) => profile.id === first.id)).toMatchObject({
      apiKey: 'key-account-a',
      model: 'gpt-transcribe',
    })
    expect(await loadActiveAsrProfile()).toMatchObject({
      id: first.id,
      apiKey: 'key-account-a',
      model: 'gpt-transcribe',
    })

    await saveAsrProfiles({ profiles: [first, second], activeId: second.id })
    const secondState = await loadAsrProfiles()
    expect(secondState.activeId).toBe(second.id)
    expect(secondState.profiles.find((profile) => profile.id === secondState.activeId)).toMatchObject({
      apiKey: 'key-account-b',
      model: 'whisper-1',
    })
    expect(await loadActiveAsrProfile()).toMatchObject({
      id: second.id,
      apiKey: 'key-account-b',
      model: 'whisper-1',
    })
  })

  it('holds a profile snapshot behind a submitted activation until the new profile is committed', async () => {
    const first = profile('openai_transcribe', {
      id: 'openai-account-a', apiKey: 'key-account-a', model: 'gpt-transcribe',
    })
    const second = profile('openai_transcribe', {
      id: 'openai-account-b', apiKey: 'key-account-b', model: 'whisper-1',
    })
    await saveAsrProfiles({ profiles: [first, second], activeId: first.id })

    const writeGate = deferred<void>()
    delayedWrites.set(ASR_ACTIVE_PROFILE_KEY, writeGate.promise)
    const activation = saveAsrProfiles({ profiles: [first, second], activeId: second.id })
    const snapshot = loadActiveAsrProfile()
    let snapshotSettled = false
    void snapshot.then(() => { snapshotSettled = true }, () => { snapshotSettled = true })

    try {
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(snapshotSettled).toBe(false)
    } finally {
      writeGate.resolve()
    }

    await activation
    await expect(snapshot).resolves.toMatchObject({
      id: second.id,
      apiKey: 'key-account-b',
      model: 'whisper-1',
    })
  })

  it('rejects a queued snapshot after activation storage fails instead of falling back to the old profile', async () => {
    const first = profile('openai_transcribe', {
      id: 'openai-account-a', apiKey: 'key-account-a', model: 'gpt-transcribe',
    })
    const second = profile('openai_transcribe', {
      id: 'openai-account-b', apiKey: 'key-account-b', model: 'whisper-1',
    })
    await saveAsrProfiles({ profiles: [first, second], activeId: first.id })
    failedWrites.add(ASR_ACTIVE_PROFILE_KEY)

    const activation = saveAsrProfiles({ profiles: [first, second], activeId: second.id })
    const snapshot = loadActiveAsrProfile()

    await expect(activation).rejects.toThrow(`write failed: ${ASR_ACTIVE_PROFILE_KEY}`)
    await expect(snapshot).rejects.toThrow(`write failed: ${ASR_ACTIVE_PROFILE_KEY}`)

    failedWrites.delete(ASR_ACTIVE_PROFILE_KEY)
    await saveAsrProfiles({ profiles: [first, second], activeId: second.id })
    await expect(loadActiveAsrProfile()).resolves.toMatchObject({ id: second.id, model: 'whisper-1' })
  })

  it('reports possible canonical activation after runtime mirror failure and blocks snapshots', async () => {
    const first = profile('openai_transcribe', {
      id: 'openai-account-a', apiKey: 'key-account-a', model: 'gpt-transcribe',
    })
    const second = profile('openai_transcribe', {
      id: 'openai-account-b', apiKey: 'key-account-b', model: 'whisper-1',
    })
    await saveAsrProfiles({ profiles: [first, second], activeId: first.id })
    failedWrites.add('cloudAsr.apiKey')

    await expect(saveAsrProfiles({ profiles: [first, second], activeId: second.id }))
      .rejects.toThrow('write failed: cloudAsr.apiKey')

    expect(storedSettings.get(ASR_ACTIVE_PROFILE_KEY)).toBe(second.id)
    expect(storedSettings.get(ASR_PROFILES_KEY)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: second.id, apiKey: 'key-account-b', model: 'whisper-1' }),
    ]))
    await expect(loadActiveAsrProfile()).rejects.toThrow('ASR profile storage is unavailable')

    expect(en['asr.msg.activationFailed']).toContain('The stored selection may have changed')
    expect(en['asr.msg.activationFailed']).toContain('Retry saving before recording')
    expect(en['asr.msg.activationFailed']).not.toMatch(/selection hasn't changed/i)
    expect(uk['asr.msg.activationFailed']).toContain('Збережений вибір міг змінитися')
    expect(uk['asr.msg.activationFailed']).toContain('Повторіть збереження перед записом')
    expect(uk['asr.msg.activationFailed']).not.toContain('Вибір не змінено')
  })

  it('drains sibling writes before rejecting and lets an explicit save recover the queue', async () => {
    const first = profile('openai_transcribe', {
      id: 'openai-account-a', apiKey: 'key-account-a', model: 'gpt-transcribe',
    })
    const second = profile('openai_transcribe', {
      id: 'openai-account-b', apiKey: 'key-account-b', model: 'whisper-1',
    })
    const third = profile('openai_transcribe', {
      id: 'openai-account-c', apiKey: 'key-account-c', model: 'gpt-4o-transcribe',
    })
    await saveAsrProfiles({ profiles: [first, second, third], activeId: first.id })

    const runtimeWriteGate = deferred<void>()
    delayedWrites.set('cloudAsr.provider', runtimeWriteGate.promise)
    failedWrites.add('cloudAsr.apiKey')
    const runtimeFailureStarted = deferred<void>()
    writeStarted.set('cloudAsr.apiKey', runtimeFailureStarted.resolve)

    const failedActivation = saveAsrProfiles({ profiles: [first, second, third], activeId: second.id })
    const snapshot = loadActiveAsrProfile()
    const recovery = saveAsrProfiles({ profiles: [first, second, third], activeId: third.id })
    let activationSettled = false
    void failedActivation.then(() => { activationSettled = true }, () => { activationSettled = true })

    try {
      await runtimeFailureStarted.promise
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(activationSettled).toBe(false)
    } finally {
      failedWrites.delete('cloudAsr.apiKey')
      delayedWrites.delete('cloudAsr.provider')
      runtimeWriteGate.resolve()
    }

    await expect(failedActivation).rejects.toThrow('write failed: cloudAsr.apiKey')
    await expect(snapshot).rejects.toThrow('ASR profile storage is unavailable')
    await recovery
    await expect(loadActiveAsrProfile()).resolves.toMatchObject({
      id: third.id,
      apiKey: 'key-account-c',
      model: 'gpt-4o-transcribe',
    })
    expect(storedSettings.get('cloudAsr.provider')).toBe('openai_transcribe')
    expect(storedSettings.get('cloudAsr.apiKey')).toBe('key-account-c')
  })

  it('applies late test results to the latest profile list without restoring its stale active ID', async () => {
    const first = profile('openai_transcribe', {
      id: 'openai-account-a', apiKey: 'key-account-a', model: 'gpt-transcribe',
    })
    const second = profile('openai_transcribe', {
      id: 'openai-account-b', apiKey: 'key-account-b', model: 'whisper-1',
    })
    await saveAsrProfiles({ profiles: [first, second], activeId: first.id })

    const writeGate = deferred<void>()
    delayedWrites.set(ASR_ACTIVE_PROFILE_KEY, writeGate.promise)
    const activation = saveAsrProfiles({ profiles: [first, second], activeId: second.id })
    const check: AsrCheck = { ok: true, at: 123, latencyMs: 250, audioSec: 2 }
    let completion: ReturnType<typeof saveAsrProfileChecks>
    try {
      completion = saveAsrProfileChecks([{ profile: first, check }])
    } finally {
      writeGate.resolve()
    }

    await activation
    const state = await completion!
    expect(state.activeId).toBe(second.id)
    expect(state.profiles.find(({ id }) => id === first.id)?.check).toEqual(check)
    expect(await loadActiveAsrProfile()).toMatchObject({ id: second.id, apiKey: 'key-account-b', model: 'whisper-1' })
    expect(storedSettings.get(ASR_PROFILES_KEY)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id, check }),
      expect.objectContaining({ id: second.id, apiKey: 'key-account-b', model: 'whisper-1' }),
    ]))
  })
})
