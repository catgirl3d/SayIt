import { beforeEach, describe, expect, it, vi } from 'vitest'

const getSettingMock = vi.fn()

vi.mock('../store', () => ({ getSetting: (...args: unknown[]) => getSettingMock(...args) }))
vi.mock('@/i18n', () => ({ t: (key: string) => key, tForLocale: (key: string) => key }))

import {
  DEFAULT_LOCAL_MODEL_ID,
  checkLocalModelInstalled,
  getSelectedLocalModelId,
  resolveLocalModelName,
  type LocalModelIpc,
} from '../localModelStatus'

/** Typed IPC fake: vi.fn's Mock<> erases the generic, so track calls manually. */
function fakeIpc(responder: (command: string) => unknown): { ipc: LocalModelIpc; commands: string[] } {
  const commands: string[] = []
  const ipc: LocalModelIpc = <T>(command: string): Promise<T> => {
    commands.push(command)
    return Promise.resolve(responder(command) as T)
  }
  return { ipc, commands }
}

describe('selected local model id', () => {
  beforeEach(() => {
    getSettingMock.mockReset()
  })

  it('is the default registered in the settings registry', () => {
    expect(DEFAULT_LOCAL_MODEL_ID).toBe('nemotron-asr-streaming-0.6b-gguf')
  })

  it('reads the stored id with the default as the setting fallback', async () => {
    getSettingMock.mockResolvedValue('qwen3-asr-1.7b-gguf')

    await expect(getSelectedLocalModelId()).resolves.toBe('qwen3-asr-1.7b-gguf')
    expect(getSettingMock).toHaveBeenCalledWith('localAsr.modelId', DEFAULT_LOCAL_MODEL_ID)
  })

  it('treats an empty stored value as the default model', async () => {
    getSettingMock.mockResolvedValue('')

    await expect(getSelectedLocalModelId()).resolves.toBe(DEFAULT_LOCAL_MODEL_ID)
  })

  it('propagates setting read failures instead of reporting the default', async () => {
    getSettingMock.mockRejectedValue(new Error('store offline'))

    await expect(getSelectedLocalModelId()).rejects.toThrow('store offline')
  })
})

describe('local model readiness rule', () => {
  it('requires the selected id itself to be complete', async () => {
    const { ipc, commands } = fakeIpc(() => [
      { id: 'other-model-gguf', complete: true },
      { id: 'selected-model-gguf', complete: false },
    ])

    await expect(checkLocalModelInstalled(ipc, 'selected-model-gguf')).resolves.toBe(false)
    expect(commands).toEqual(['list_downloaded_models'])
  })

  it('treats a completely downloaded model as installed', async () => {
    const { ipc } = fakeIpc(() => [{ id: 'sensevoice-small-gguf', complete: true }])

    await expect(checkLocalModelInstalled(ipc, 'sensevoice-small-gguf')).resolves.toBe(true)
  })

  it('rejects instead of reporting not-installed when the list cannot be read', async () => {
    const { ipc } = fakeIpc(() => {
      throw new Error('ipc boom')
    })

    await expect(checkLocalModelInstalled(ipc, 'sensevoice-small-gguf')).rejects.toThrow('ipc boom')
  })

  it('does not consult the model catalog', async () => {
    const { ipc, commands } = fakeIpc(() => [{ id: 'sensevoice-small-gguf', complete: true }])

    await checkLocalModelInstalled(ipc, 'sensevoice-small-gguf')

    expect(commands).toEqual(['list_downloaded_models'])
  })
})

describe('local model display name', () => {
  it('resolves a mapped id from the built-in map without IPC', async () => {
    const { ipc, commands } = fakeIpc(() => [])

    await expect(resolveLocalModelName(ipc, 'sensevoice-small-gguf')).resolves.toBe('localModel.sensevoice.name')
    expect(commands).toEqual([])
  })

  it('enriches an unmapped id best-effort from the catalog name', async () => {
    const { ipc, commands } = fakeIpc(() => [{ id: 'future-model-gguf', name: 'Future Model' }])

    await expect(resolveLocalModelName(ipc, 'future-model-gguf')).resolves.toBe('Future Model')
    expect(commands).toEqual(['list_available_models'])
  })

  it('falls back to the raw id when the catalog fails for an unmapped id', async () => {
    const { ipc } = fakeIpc(() => {
      throw new Error('catalog down')
    })

    await expect(resolveLocalModelName(ipc, 'future-model-gguf')).resolves.toBe('future-model-gguf')
  })
})
