import { describe, it, expect } from 'vitest'
import {
  ASR_PLATFORMS,
  ASR_PROVIDERS,
  asrAvailabilityLabel,
  buildAsrProviderConfig,
  changeAsrProfileProvider,
  CUSTOM_ASR_PROVIDER,
  describeAsrMissing,
  effectiveAsrCredentials,
  emptyAsrProfile,
  findAsrProvider,
  gradeAsrLatency,
  keyFingerprint,
  normalizeAsrProfileForSave,
  parseAsrProfiles,
  providersOfPlatform,
  resolveActiveAsrProfile,
  type AsrProfile,
} from '../asrProviderCatalog'

function profile(over: Partial<AsrProfile> = {}): AsrProfile {
  return { ...emptyAsrProfile(), ...over }
}

describe('ASR_PROVIDERS 结构性不变量', () => {
  it('id 唯一', () => {
    const ids = ASR_PROVIDERS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('每项都有标题、模型名、一句定位', () => {
    for (const p of ASR_PROVIDERS) {
      expect(p.label.trim()).not.toBe('')
      if (!p.customEndpoint) expect(p.model.trim()).not.toBe('')
      expect(p.blurb.trim()).not.toBe('')
      expect(['mainland_china', 'global', 'custom']).toContain(p.availability)
    }
  })

  // 这条断言变过两次，记下来免得再绕回去：
  //   v1「每一家都是 mainland_china」—— 只是把当时的事实写死，加海外供应商时它拦的是新功能；
  //   v2「每种地区都有展示文案」—— 于是七张卡上各挂一句「面向中国大陆账号」，是纯噪音；
  //   现在：国内是默认情形，不给字；只有需要海外账号/网络的才提醒。
  it('只有海外供应商才给地区提示，国内的不占字', () => {
    for (const p of ASR_PROVIDERS) {
      const label = asrAvailabilityLabel(p).trim()
      if (p.availability === 'global') expect(label).not.toBe('')
      else expect(label).toBe('')
    }
    // 至少还有一家是海外的，否则上面那半条断言等于没跑
    expect(ASR_PROVIDERS.some((p) => p.availability === 'global')).toBe(true)
  })

  it('平台都在 ASR_PLATFORMS 里有定义', () => {
    for (const p of ASR_PROVIDERS) expect(ASR_PLATFORMS[p.platform]).toBeTruthy()
  })

  // 卡片标题不该再出现「（qwen3.5-omni-plus，ASR+AI）」这种括号串——模型名有自己的一行
  it('标题不带括号与模型名', () => {
    for (const p of ASR_PROVIDERS) {
      expect(p.label).not.toMatch(/[（(]/)
      if (p.model) expect(p.label).not.toContain(p.model)
    }
  })

  it('6 Qwen profiles share the same credential platform', () => {
    expect(providersOfPlatform('qwen').map((p) => p.id)).toEqual([
      'qwen_audio_stream', 'qwen', 'qwen_realtime', 'qwen_omni_35_plus', 'qwen_omni_35_flash',
      'qwen_omni_38_realtime',
    ])
  })

  it('describes Qwen 3.8 Omni as buffered without unverified quality claims', () => {
    const provider = findAsrProvider('qwen_omni_38_realtime')

    expect(provider).toMatchObject({
      id: 'qwen_omni_38_realtime',
      model: 'qwen3.8-omni-flash-realtime',
      platform: 'qwen',
      omni: true,
    })
    expect(provider?.label).toContain('Qwen 3.8 Omni Flash')
    expect(provider?.blurb).toMatch(/after you finish speaking/i)
    expect(provider?.blurb).toMatch(/does not mean live captions/i)
    expect(provider?.blurb).not.toMatch(/more accurate|faster|cheaper|superior/i)
  })

  /** 清单顺序就是推荐顺序（卡片顺序 + 新建下拉的顺序），前两名钉住 */
  it('推荐顺序：豆包第一，千问 Audio 3.1 第二', () => {
    expect(ASR_PROVIDERS.slice(0, 2).map((p) => p.id)).toEqual(['doubao_v2', 'qwen_audio_stream'])
  })

  it('Qwen Audio catalog identifies the active 3.1 model without unverified quality claims', () => {
    const provider = findAsrProvider('qwen_audio_stream')

    expect(provider?.model).toBe('qwen-audio-3.1-asr-flash-streaming')
    expect(provider?.label).toContain('Qwen Audio 3.1')
    expect(provider?.blurb.toLowerCase()).not.toMatch(/accuracy|accurate|fast|quick/)
  })

  /**
   * Only qwen3-asr-flash-realtime requires a workspace ID. The existing
   * no-workspace behavior is preserved for Qwen Audio; the historical generic-host
   * probe covered 3.0 and is not evidence of a live 3.1 connection.
   */
  it('只有 qwen_realtime 需要业务空间 ID', () => {
    expect(ASR_PROVIDERS.filter((p) => p.needsWorkspaceId).map((p) => p.id)).toEqual([
      'qwen_realtime',
    ])
  })

  it('findAsrProvider 查得到也查不崩', () => {
    expect(findAsrProvider('doubao_v2')?.platform).toBe('doubao')
    expect(findAsrProvider('nope')).toBeUndefined()
  })

  it('exposes the frozen buffered provider defaults and model choices', () => {
    expect(findAsrProvider('openai_transcribe')).toMatchObject({
      platform: 'openai',
      model: 'gpt-transcribe',
      models: ['gpt-transcribe', 'gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1'],
    })
    expect(findAsrProvider('gemini_transcribe')).toMatchObject({
      platform: 'gemini',
      model: 'gemini-3.5-transcribe',
      models: ['gemini-3.5-transcribe'],
    })
    expect(findAsrProvider('openrouter_transcribe')).toMatchObject({
      platform: 'openrouter',
      model: 'openai/gpt-transcribe',
      models: [
        'openai/gpt-transcribe',
        'qwen/qwen3-asr-flash-2026-02-10',
        'qwen/qwen3-asr-1.7b',
        'qwen/qwen3-asr-0.6b',
        'microsoft/mai-transcribe-2',
        'google/chirp-3',
        'microsoft/mai-transcribe-1.5',
        'openai/gpt-4o-transcribe',
        'openai/gpt-4o-mini-transcribe',
        'openai/whisper-large-v3-turbo',
        'openai/whisper-large-v3',
        'openai/whisper-1',
        'deepgram/nova-3',
        'meta/muse-voice-transcribe-1.0',
        'x-ai/grok-stt-1.0',
        'mistralai/voxtral-mini-transcribe',
        'mistralai/voxtral-small-24b-2507-stt',
        'mistralai/voxtral-mini-3b-2507',
        'nvidia/parakeet-tdt-0.6b-v3',
        'nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b',
        'fish-audio/transcribe-1',
      ],
    })
  })

  it('keeps existing Groq profile credentials and language payload intact', () => {
    const groq = profile({ provider: 'groq_whisper', apiKey: 'groq-profile-key' })
    expect(buildAsrProviderConfig(groq, 'uk')).toEqual({
      provider: 'groq_whisper',
      api_key: 'groq-profile-key',
      app_id: '',
      extra: { language: 'uk' },
    })
  })

  it('keeps providers without extra payloads unchanged', () => {
    expect(buildAsrProviderConfig(profile({ provider: 'doubao_v2' }), 'auto').extra).toBeUndefined()
  })

  it('round-trips custom endpoint settings and defaults old profiles to one explicit protocol', () => {
    expect(emptyAsrProfile(CUSTOM_ASR_PROVIDER).protocol).toBe('transcriptions')
    const [custom, oldCustom] = parseAsrProfiles([
      {
        id: 'custom-chat',
        provider: 'openai_compat',
        baseUrl: 'http://localhost:8090/v1',
        model: 'local-audio-model',
        apiKey: 'profile-key',
        protocol: 'chat',
      },
      {
        id: 'custom-legacy',
        provider: 'openai_compat',
        baseUrl: 'https://asr.example.test/v1',
      },
    ])

    expect(custom).toMatchObject({
      id: 'custom-chat',
      baseUrl: 'http://localhost:8090/v1',
      model: 'local-audio-model',
      apiKey: 'profile-key',
      protocol: 'chat',
    })
    expect(oldCustom).toMatchObject({
      id: 'custom-legacy',
      baseUrl: 'https://asr.example.test/v1',
      model: '',
      apiKey: '',
      protocol: 'transcriptions',
    })
    expect(buildAsrProviderConfig(custom, 'uk')).toEqual({
      provider: 'openai_compat',
      api_key: 'profile-key',
      app_id: '',
      extra: {
        model: 'local-audio-model',
        base_url: 'http://localhost:8090/v1',
        protocol: 'chat',
        language: 'uk',
      },
    })
  })

  it('trims freeform custom model names in the actual provider request payload', () => {
    const custom = profile({
      provider: CUSTOM_ASR_PROVIDER,
      baseUrl: 'http://localhost:8090/v1',
      model: '  local-audio-model  ',
    })

    expect(buildAsrProviderConfig(custom, 'uk').extra?.model).toBe('local-audio-model')
    expect(buildAsrProviderConfig(profile({ provider: 'openai_transcribe', model: 'whisper-1' }), 'uk').extra?.model)
      .toBe('whisper-1')
  })

  it('canonicalizes custom model whitespace at the profile save boundary without changing built-ins', () => {
    const custom = profile({
      provider: CUSTOM_ASR_PROVIDER,
      model: '  local-audio-model  ',
      check: { ok: true, at: 123, latencyMs: 100, audioSec: 2 },
    })
    const savedCustom = normalizeAsrProfileForSave(custom)
    const savedOpenAi = normalizeAsrProfileForSave(profile({ provider: 'openai_transcribe', model: 'whisper-1' }))

    expect(savedCustom).toMatchObject({
      model: 'local-audio-model',
      check: custom.check,
    })
    expect(savedOpenAi.model).toBe('whisper-1')
  })

  it('round-trips the 3.8 profile and sends its exact model through qwen_omni', () => {
    const [profile] = parseAsrProfiles([{
      id: 'qwen38-account-a',
      provider: 'qwen_omni_38_realtime',
      apiKey: 'qwen38-key',
      omniPrompt: 'Transcribe faithfully.',
    }])

    expect(profile).toMatchObject({
      id: 'qwen38-account-a',
      provider: 'qwen_omni_38_realtime',
      model: 'qwen3.8-omni-flash-realtime',
      apiKey: 'qwen38-key',
    })
    expect(buildAsrProviderConfig(profile, 'uk')).toEqual({
      provider: 'qwen_omni',
      api_key: 'qwen38-key',
      app_id: '',
      extra: {
        model: 'qwen3.8-omni-flash-realtime',
        instructions: 'Transcribe faithfully.',
      },
    })

    const [qwen35] = parseAsrProfiles([{
      id: 'qwen35-account-a',
      provider: 'qwen_omni_35_flash',
      apiKey: 'qwen35-key',
    }])
    expect(qwen35.model).toBe('qwen3.5-omni-flash')
    expect(buildAsrProviderConfig(qwen35, 'uk').extra).toEqual({
      model: 'qwen3.5-omni-flash-realtime',
      instructions: undefined,
    })
  })
})

describe('parseAsrProfiles 容错', () => {
  it('非数组一律当空列表', () => {
    expect(parseAsrProfiles(null)).toEqual([])
    expect(parseAsrProfiles({})).toEqual([])
    expect(parseAsrProfiles('x')).toEqual([])
  })

  it('丢掉供应商不在内置清单里的条目', () => {
    // 留着只会渲染出一张点不动的卡
    const r = parseAsrProfiles([
      { id: 'a', provider: 'doubao_v2' },
      { id: 'b', provider: 'gpt-4-asr' },
      { id: 'c' },
    ])
    expect(r.map((p) => p.id)).toEqual(['a'])
  })

  it('丢掉重复 id', () => {
    const r = parseAsrProfiles([
      { id: 'a', provider: 'doubao_v2' },
      { id: 'a', provider: 'qwen' },
    ])
    expect(r).toHaveLength(1)
  })

  it('缺字段补成空串，不会渲染出 undefined', () => {
    const [p] = parseAsrProfiles([{ id: 'a', provider: 'qwen' }])
    expect(p.apiKey).toBe('')
    expect(p.appId).toBe('')
    expect(p.workspaceId).toBe('')
    expect(p.omniPrompt).toBe('')
    expect(p.console).toBe('new')
  })

  it('fills each provider-specific default when a saved profile has no model', () => {
    expect(parseAsrProfiles([
      { id: 'legacy-openai', provider: 'openai_transcribe', apiKey: 'openai-key' },
      { id: 'legacy-gemini', provider: 'gemini_transcribe', apiKey: 'gemini-key' },
      { id: 'legacy-openrouter', provider: 'openrouter_transcribe', apiKey: 'openrouter-key' },
    ]).map((profile) => profile.model)).toEqual([
      'gpt-transcribe',
      'gemini-3.5-transcribe',
      'openai/gpt-transcribe',
    ])
  })

  it('console 只认 new / legacy，其它值回落到 new', () => {
    expect(parseAsrProfiles([{ id: 'a', provider: 'doubao_v2', console: 'legacy' }])[0].console).toBe('legacy')
    expect(parseAsrProfiles([{ id: 'a', provider: 'doubao_v2', console: 'garbage' }])[0].console).toBe('new')
  })

  it('坏的检测结论被丢掉，好的保留', () => {
    const r = parseAsrProfiles([
      { id: 'a', provider: 'qwen', check: { ok: true, at: 100, latencyMs: 800, audioSec: 3 } },
      { id: 'b', provider: 'qwen', check: { ok: true } },
      { id: 'c', provider: 'qwen', check: 'nope' },
    ])
    expect(r[0].check).toEqual({ ok: true, at: 100, latencyMs: 800, audioSec: 3, reason: undefined })
    expect(r[1].check).toBeUndefined()
    expect(r[2].check).toBeUndefined()
  })

  it('没有 id 时自动补一个，不会整条丢掉', () => {
    const r = parseAsrProfiles([{ provider: 'qwen', apiKey: 'sk-1' }])
    expect(r).toHaveLength(1)
    expect(r[0].id).not.toBe('')
  })
})

describe('resolveActiveAsrProfile', () => {
  it('指向不存在的 id 时回落到第一条', () => {
    const list = [profile({ id: 'a' }), profile({ id: 'b' })]
    expect(resolveActiveAsrProfile(list, 'zzz')?.id).toBe('a')
    expect(resolveActiveAsrProfile(list, 'b')?.id).toBe('b')
  })

  it('空列表返回 null', () => {
    expect(resolveActiveAsrProfile([], 'a')).toBeNull()
  })
})

describe('effectiveAsrCredentials', () => {
  // 核心不变量：Rust 侧靠 app_id 空不空来选两代鉴权头
  it('豆包新版控制台必须把 appId 清空', () => {
    const p = profile({
      provider: 'doubao_v2', console: 'new', apiKey: 'APPKEY', otherKey: 'TOKEN', appId: '1234567890',
    })
    expect(effectiveAsrCredentials(p)).toEqual({ apiKey: 'APPKEY', appId: '' })
  })

  it('豆包旧版控制台用 Access Token + App ID', () => {
    const p = profile({
      provider: 'doubao_v2', console: 'legacy', apiKey: 'TOKEN', otherKey: 'APPKEY', appId: '1234567890',
    })
    expect(effectiveAsrCredentials(p)).toEqual({ apiKey: 'TOKEN', appId: '1234567890' })
  })

  it('非豆包平台不带 appId', () => {
    const p = profile({ provider: 'qwen', apiKey: ' sk-1 ', appId: '999' })
    expect(effectiveAsrCredentials(p)).toEqual({ apiKey: 'sk-1', appId: '' })
  })
})

describe('describeAsrMissing', () => {
  it('豆包新版只要密钥', () => {
    expect(describeAsrMissing(profile({ provider: 'doubao_v2', console: 'new' }))).toBe('no API key yet')
    expect(describeAsrMissing(profile({ provider: 'doubao_v2', console: 'new', apiKey: 'k' }))).toBe('')
  })

  it('豆包旧版两个都要，且先报密钥', () => {
    expect(describeAsrMissing(profile({ provider: 'doubao_v2', console: 'legacy' }))).toBe('no Access Token yet')
    expect(describeAsrMissing(profile({ provider: 'doubao_v2', console: 'legacy', apiKey: 't' }))).toBe('no App ID yet')
    expect(describeAsrMissing(profile({ provider: 'doubao_v2', console: 'legacy', apiKey: 't', appId: '1' }))).toBe('')
  })

  it('其它平台只要 API Key', () => {
    expect(describeAsrMissing(profile({ provider: 'mimo' }))).toBe('no API key yet')
    expect(describeAsrMissing(profile({ provider: 'mimo', apiKey: 'k' }))).toBe('')
  })

  it('custom endpoints require a safe HTTP(S) URL and model, but not an API key', () => {
    expect(describeAsrMissing(profile({ provider: 'openai_compat' }))).toBe('base URL is required')
    expect(describeAsrMissing(profile({
      provider: 'openai_compat',
      baseUrl: 'ftp://asr.example.test/v1',
      model: 'local-model',
    }))).toMatch(/HTTP\(S\)/)
    expect(describeAsrMissing(profile({
      provider: 'openai_compat',
      baseUrl: 'https://user:secret@asr.example.test/v1',
      model: 'local-model',
    }))).toMatch(/without username or password/)
    expect(describeAsrMissing(profile({
      provider: 'openai_compat',
      baseUrl: 'https://asr.example.test/v1?token=secret',
      model: 'local-model',
    }))).toMatch(/without username or password/)
    expect(describeAsrMissing(profile({
      provider: 'openai_compat',
      baseUrl: 'http://localhost:8090/v1',
      model: '',
    }))).toBe('model is required')
    expect(describeAsrMissing(profile({
      provider: 'openai_compat',
      baseUrl: 'http://localhost:8090/v1',
      model: 'local-model',
    }))).toBe('')
  })
})

describe('changeAsrProfileProvider', () => {
  it('clears custom route, model, and key when switching providers', () => {
    const custom = profile({
      provider: 'openai_compat',
      baseUrl: 'http://localhost:8090/v1',
      model: 'private-model',
      apiKey: 'custom-key',
      protocol: 'chat',
    })
    const builtIn = changeAsrProfileProvider(custom, 'openai_transcribe')

    expect(builtIn).toMatchObject({
      provider: 'openai_transcribe',
      model: 'gpt-transcribe',
      apiKey: '',
    })
    expect(builtIn).not.toHaveProperty('baseUrl')
    expect(builtIn).not.toHaveProperty('protocol')

    const freshCustom = changeAsrProfileProvider(builtIn, 'openai_compat')
    expect(freshCustom).toMatchObject({
      provider: 'openai_compat',
      model: '',
      apiKey: '',
      baseUrl: '',
      protocol: 'transcriptions',
    })
  })
})

describe('keyFingerprint', () => {
  it('只露最后 4 位，够区分同一家的两份配置', () => {
    expect(keyFingerprint(profile({ provider: 'qwen', apiKey: 'sk-abcdef1234' }))).toBe('••1234')
  })

  it('密钥太短或为空时不给指纹，避免把整把密钥露出来', () => {
    expect(keyFingerprint(profile({ provider: 'qwen', apiKey: 'ab' }))).toBe('')
    expect(keyFingerprint(profile({ provider: 'qwen', apiKey: '' }))).toBe('')
  })

  it('豆包按当前代次的生效密钥取，不会取到另一代那把', () => {
    const p = profile({ provider: 'doubao_v2', console: 'new', apiKey: 'NEWKEY9999', otherKey: 'OLD1111' })
    expect(keyFingerprint(p)).toBe('••9999')
  })
})

describe('gradeAsrLatency', () => {
  // 口径是 RTF，不是绝对毫秒。3 秒音频花 1 秒是正常水平，
  // 若照搬 AI 服务那套「1 秒就算慢」的阈值，所有 ASR 都会被标成太慢。
  it('3 秒音频花 1 秒算正常，不算慢', () => {
    expect(gradeAsrLatency(1000, 3).tone).toBe('ok')
    expect(gradeAsrLatency(1000, 3).label).toBe('Normal')
  })

  it('按 RTF 分档', () => {
    expect(gradeAsrLatency(300, 3).label).toBe('Instant')
    expect(gradeAsrLatency(700, 3).label).toBe('Fast')
    expect(gradeAsrLatency(1200, 3).label).toBe('Normal')
    expect(gradeAsrLatency(2000, 3).label).toBe('Slow')
    expect(gradeAsrLatency(3000, 3).label).toBe('Too slow')
  })

  it('同样的毫秒数，音频越长档位越好', () => {
    // 刻意不取边界值：阈值是「小于」，1500/10s 正好等于 0.15 会落进 fast 而非 instant
    expect(gradeAsrLatency(1000, 2).tier).toBe('slow')
    expect(gradeAsrLatency(1000, 10).tier).toBe('instant')
  })

  it('阈值是「小于」，边界值落进下一档', () => {
    expect(gradeAsrLatency(150, 1).tier).toBe('fast')
    expect(gradeAsrLatency(149, 1).tier).toBe('instant')
  })

  it('只有太慢才给 bad —— 红色留给「不可用」', () => {
    expect(gradeAsrLatency(2000, 3).tone).toBe('warn')
    expect(gradeAsrLatency(9000, 3).tone).toBe('bad')
  })

  it('音频时长缺失时不硬猜档位', () => {
    expect(gradeAsrLatency(1000, 0).label).toBe('Works')
    expect(gradeAsrLatency(1000, NaN).label).toBe('Works')
  })
})
