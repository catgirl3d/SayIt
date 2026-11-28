import { api } from './client'
import { getDefault } from '../defaults'

export async function getSetting<T>(key: string, fallback?: T): Promise<T> {
  const defaultValue = getDefault(key, fallback) as T
  const client = api()
  if (!client?.storeGet) {
    console.warn('[store] getSetting called before bridge is ready:', key)
    return defaultValue
  }
  const val = await client.storeGet(key)
  if (val === null || val === undefined) return defaultValue
  // 运行时类型校验：如果 defaultValue 有明确类型，检查返回值类型是否匹配
  if (defaultValue !== null && defaultValue !== undefined) {
    const expectedType = typeof defaultValue
    if (expectedType === 'string' || expectedType === 'number' || expectedType === 'boolean') {
      if (typeof val !== expectedType) return defaultValue
    }
  }
  return val as T
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await api().storeSet(key, value)
}

/** Save ordinary settings together; collection keys use their dedicated APIs. */
export async function setSettings(settings: Record<string, unknown>): Promise<void> {
  await api().storeSetAppSettings(settings)
}
