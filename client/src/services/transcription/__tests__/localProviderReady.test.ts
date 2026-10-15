import { describe, it, expect, vi, beforeEach } from 'vitest'

// 这些依赖都会走 Tauri IPC，测试里替换掉
const invokeMock = vi.fn()
const getSettingMock = vi.fn()
const runtimeEvents = vi.hoisted(() => ({ addRuntimeEvent: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }))
vi.mock('../../store', () => ({ getSetting: (...args: unknown[]) => getSettingMock(...args) }))
vi.mock('../../debugLog', () => ({ addRuntimeEvent: (...args: unknown[]) => runtimeEvents.addRuntimeEvent(...args) }))

import { LocalProvider } from '../LocalProvider'

/** 让 getSetting 返回选中的模型 id，其余键给默认值 */
function settings(modelId: string) {
  getSettingMock.mockImplementation((key: string, fallback: unknown) =>
    Promise.resolve(key === 'localAsr.modelId' ? modelId : fallback),
  )
}

describe('LocalProvider 的就绪判定', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    getSettingMock.mockReset()
    runtimeEvents.addRuntimeEvent.mockReset()
  })

  it('选中的模型已完整下载 → 就绪', async () => {
    settings('sensevoice-small-gguf')
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'list_downloaded_models') {
        return Promise.resolve([{ id: 'sensevoice-small-gguf', complete: true }])
      }
      return Promise.resolve('')
    })

    const provider = new LocalProvider()
    await provider.connect({})
    expect(provider.isReady()).toBe(true)
  })

  it('模型没下载 → 未就绪（设置页写着"按下快捷键不会有反应"，就必须真的拦住）', async () => {
    settings('sensevoice-small-gguf')
    invokeMock.mockImplementation((cmd: string) => Promise.resolve(cmd === 'list_downloaded_models' ? [] : ''))

    const provider = new LocalProvider()
    await provider.connect({})
    expect(provider.isReady()).toBe(false)
  })

  it('模型下载不完整 → 未就绪', async () => {
    settings('sensevoice-small-gguf')
    invokeMock.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === 'list_downloaded_models' ? [{ id: 'sensevoice-small-gguf', complete: false }] : ''),
    )

    const provider = new LocalProvider()
    await provider.connect({})
    expect(provider.isReady()).toBe(false)
  })

  it('选中的是另一个模型（已下载的不是它）→ 未就绪', async () => {
    settings('qwen3-asr-1.7b-gguf')
    invokeMock.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === 'list_downloaded_models' ? [{ id: 'sensevoice-small-gguf', complete: true }] : ''),
    )

    const provider = new LocalProvider()
    await provider.connect({})
    expect(provider.isReady()).toBe(false)
  })

  it('读不到模型列表 → 按未就绪处理（宁可拦下，也别录完才失败）', async () => {
    settings('sensevoice-small-gguf')
    invokeMock.mockImplementation((cmd: string) =>
      cmd === 'list_downloaded_models' ? Promise.reject(new Error('ipc boom')) : Promise.resolve(''),
    )

    const provider = new LocalProvider()
    await provider.connect({})
    expect(provider.isReady()).toBe(false)
    expect(runtimeEvents.addRuntimeEvent).toHaveBeenCalledWith(
      'warn', 'local', 'Could not read local model list; provider is not ready', { error: 'Error: ipc boom' },
    )
    expect(runtimeEvents.addRuntimeEvent).not.toHaveBeenCalledWith(
      'warn', 'local', 'Selected local model is not downloaded; provider is not ready', expect.anything(),
    )
  })

  it('已下载但预加载失败 → 仍算就绪（真正原因留给识别阶段报，不谎称"没下载"）', async () => {
    settings('sensevoice-small-gguf')
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'list_downloaded_models') {
        return Promise.resolve([{ id: 'sensevoice-small-gguf', complete: true }])
      }
      if (cmd === 'preload_local_model') return Promise.reject(new Error('vulkan boom'))
      return Promise.resolve('')
    })

    const provider = new LocalProvider()
    await provider.connect({})
    expect(provider.isReady()).toBe(true)
  })

  it('treats an empty stored id as the default model', async () => {
    settings('')
    invokeMock.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === 'list_downloaded_models' ? [{ id: 'sensevoice-small-gguf', complete: true }] : ''),
    )

    const provider = new LocalProvider()
    await provider.connect({})
    expect(provider.isReady()).toBe(true)
  })

  it('preloads the same model id it checked', async () => {
    settings('qwen3-asr-1.7b-gguf')
    invokeMock.mockImplementation((cmd: string) =>
      Promise.resolve(cmd === 'list_downloaded_models' ? [{ id: 'qwen3-asr-1.7b-gguf', complete: true }] : ''),
    )

    const provider = new LocalProvider()
    await provider.connect({})
    expect(invokeMock).toHaveBeenCalledWith('preload_local_model', { modelId: 'qwen3-asr-1.7b-gguf', accelerator: 'auto' })
  })

  it('transcribes with the same normalized id it checked when the stored id is empty', async () => {
    settings('')
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'list_downloaded_models') return Promise.resolve([{ id: 'sensevoice-small-gguf', complete: true }])
      if (cmd === 'local_transcribe') return Promise.resolve({ text: '', elapsed_ms: 5 })
      return Promise.resolve('')
    })

    const provider = new LocalProvider()
    await provider.connect({})
    expect(provider.isReady()).toBe(true)
    provider.start({ runId: 1 })
    provider.sendAudio(new ArrayBuffer(16_000))
    provider.stop()

    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('local_transcribe', {
        audioB64: expect.any(String),
        modelId: 'sensevoice-small-gguf',
        language: 'auto',
        accelerator: 'auto',
      })
    })
  })
})
