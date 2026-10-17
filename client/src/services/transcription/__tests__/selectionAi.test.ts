import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TextContext } from '@/types/appContext'
import { DEFAULTS } from '../../defaults'
import { CONTEXT_SELECTION_AI_PROFILE_KEY, loadSelectionAiConfig } from '../selectionAi'
import { polishWithClientAi } from '../clientAiPolish'

const store = vi.hoisted(() => ({ getSetting: vi.fn() }))
const profileStore = vi.hoisted(() => ({ loadAiProfiles: vi.fn() }))
const log = vi.hoisted(() => ({ addRuntimeEvent: vi.fn() }))
const boundary = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => boundary.invoke(...args),
}))

vi.mock('../../store', () => ({
  getSetting: (...args: unknown[]) => store.getSetting(...args),
}))
vi.mock('@/features/settings/aiProfileStore', () => ({
  loadAiProfiles: (...args: unknown[]) => profileStore.loadAiProfiles(...args),
}))
vi.mock('../../debugLog', () => ({
  addRuntimeEvent: (...args: unknown[]) => log.addRuntimeEvent(...args),
}))

const selectionContext = (over: Partial<TextContext> = {}): TextContext => ({
  source: 'uia',
  textBefore: 'prefix',
  selectedText: 'Original selection',
  textAfter: 'suffix',
  selectionTruncated: false,
  ...over,
})

const editorProfile = {
  id: 'p-editor',
  provider: 'openai',
  apiUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-edit',
  model: 'gpt-edit',
  reasoningEffort: 'high',
  serviceTier: 'priority',
}

describe('selection-edit model setting', () => {
  it('defaults to an empty profile id so selection edits keep the dictation model', () => {
    expect(DEFAULTS['contextSelectionAiProfileId']).toBe('')
  })
})

describe('loadSelectionAiConfig', () => {
  beforeEach(() => {
    store.getSetting.mockReset()
    profileStore.loadAiProfiles.mockReset()
    log.addRuntimeEvent.mockReset()
  })

  it.each([null, undefined, selectionContext({ selectedText: '' }), selectionContext({ selectionTruncated: true })])(
    'does not read any setting without a usable selection (%j)',
    async (context) => {
      expect(await loadSelectionAiConfig(context)).toBeNull()
      expect(store.getSetting).not.toHaveBeenCalled()
      expect(profileStore.loadAiProfiles).not.toHaveBeenCalled()
    },
  )

  it('keeps the default route without reading the service list when no service is chosen', async () => {
    store.getSetting.mockResolvedValue('')
    expect(await loadSelectionAiConfig(selectionContext())).toBeNull()
    expect(store.getSetting).toHaveBeenCalledTimes(1)
    expect(store.getSetting).toHaveBeenCalledWith(CONTEXT_SELECTION_AI_PROFILE_KEY, '')
    expect(profileStore.loadAiProfiles).not.toHaveBeenCalled()
  })

  it('falls back to the dictation model when the saved service is gone', async () => {
    store.getSetting.mockResolvedValue('deleted')
    profileStore.loadAiProfiles.mockResolvedValue({ profiles: [editorProfile], activeId: '' })
    expect(await loadSelectionAiConfig(selectionContext())).toBeNull()
    expect(log.addRuntimeEvent).toHaveBeenCalledWith('warn', 'ai', expect.any(String))
  })

  it('falls back safely when the service list cannot be read', async () => {
    store.getSetting.mockResolvedValue('p-editor')
    profileStore.loadAiProfiles.mockRejectedValue(new Error('storage unavailable'))
    expect(await loadSelectionAiConfig(selectionContext())).toBeNull()
    expect(log.addRuntimeEvent).toHaveBeenCalledWith('warn', 'ai', expect.any(String))
  })

  it('freezes provider, endpoint, key, model and the OpenAI tuning fields', async () => {
    store.getSetting.mockResolvedValue('p-editor')
    profileStore.loadAiProfiles.mockResolvedValue({ profiles: [editorProfile], activeId: '' })
    const snapshot = await loadSelectionAiConfig(selectionContext())
    expect(snapshot).toEqual({
      provider: 'openai',
      apiUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-edit',
      model: 'gpt-edit',
      reasoningEffort: 'high',
      serviceTier: 'priority',
    })
    // The runtime copy must not carry the profile id: it is request-only state.
    expect(snapshot).not.toHaveProperty('id')
  })
})

const snapshot = {
  provider: 'openai',
  apiUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-edit',
  model: 'gpt-edit',
  reasoningEffort: 'high',
  serviceTier: 'priority',
}

function polishSelection(isCurrent: () => boolean = () => true) {
  return polishWithClientAi({
    asrText: 'make this shorter',
    durationSec: 4,
    startOptions: {
      runId: 1,
      selectionAiConfig: snapshot,
      textContext: selectionContext(),
      systemPrompt: 'Edit selected text',
    },
    logSource: 'test',
    isCurrent,
  })
}

describe('polish with a frozen selection-edit service', () => {
  beforeEach(() => {
    boundary.invoke.mockReset()
    store.getSetting.mockReset()
    log.addRuntimeEvent.mockReset()
    boundary.invoke.mockImplementation(async (command: string) =>
      command === 'cloud_polish' ? { text: 'Shorter text', elapsed_ms: 20 } : undefined)
  })

  it('never re-reads settings once the snapshot is frozen', async () => {
    const result = await polishSelection()
    expect(result).toMatchObject({ llmText: 'Shorter text', contextApplied: true, aiModel: 'gpt-edit' })
    expect(store.getSetting).not.toHaveBeenCalled()
    expect(boundary.invoke).toHaveBeenCalledWith('cloud_polish', {
      request: expect.objectContaining({
        text: 'make this shorter',
        system_prompt: 'Edit selected text',
        text_context: selectionContext(),
      }),
    })
  })

  it('carries the OpenAI tuning fields through the snapshot', async () => {
    await polishSelection()
    const [, args] = boundary.invoke.mock.calls[0] as [string, { request: { ai_config: Record<string, unknown> } }]
    expect(args.request.ai_config).toEqual({
      provider: 'openai',
      api_url: 'https://api.openai.com/v1',
      api_key: 'sk-edit',
      model: 'gpt-edit',
      extra: { reasoning_effort: 'high', service_tier: 'priority' },
    })
  })

  it('keeps the API key out of runtime logs', async () => {
    await polishSelection()
    expect(JSON.stringify(log.addRuntimeEvent.mock.calls)).not.toContain('sk-edit')
  })

  it('preserves the original selection when the chosen service fails', async () => {
    boundary.invoke.mockRejectedValue(new Error('Service unavailable'))
    expect(await polishSelection()).toMatchObject({
      llmText: 'Original selection',
      contextApplied: false,
      aiStatus: 'failed',
    })
  })

  it('sends no request for a saved service that is incomplete', async () => {
    const incomplete = { ...snapshot, apiKey: '' }
    const result = await polishWithClientAi({
      asrText: 'make this shorter',
      durationSec: 4,
      startOptions: { runId: 2, selectionAiConfig: incomplete, textContext: selectionContext() },
      logSource: 'test',
    })
    expect(result).toMatchObject({
      llmText: 'Original selection',
      aiStatus: 'unavailable',
      aiFailureReason: 'incomplete_profile',
    })
    expect(boundary.invoke).not.toHaveBeenCalled()
  })

  it('discards a canceled run before sending the editing request', async () => {
    expect(await polishSelection(() => false)).toBeNull()
    expect(boundary.invoke).not.toHaveBeenCalled()
  })
})
