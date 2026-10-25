import { storeGet } from '@/services/bridge'
import { getBackendBaseUrl } from '@/services/runtimeConfig'
import { setSetting } from '@/services/store'

export type DefaultServerMigration = 'none' | 'choose'

/**
 * Decide what to do with users who relied on the old built-in default server.
 *
 * These users never touched the mode switcher, so their stored workMode is absent while
 * the saved or built-in server address is still present: keep them on server mode
 * silently. If neither a mode nor an address is available, ask them to choose one.
 */
export async function resolveDefaultServerMigration(): Promise<DefaultServerMigration> {
  const onboardingVersion = await storeGet('onboardingVersion')
  if (!onboardingVersion) return 'none'

  const rawWorkMode = await storeGet('workMode')
  if (rawWorkMode === 'local' || rawWorkMode === 'cloud_api') return 'none'

  const hasServerUrl = getBackendBaseUrl() !== ''
  const modeIsUnset = rawWorkMode === null || rawWorkMode === undefined

  if (modeIsUnset && hasServerUrl) {
    await setSetting('workMode', 'server')
    return 'none'
  }
  if ((modeIsUnset || rawWorkMode === 'server') && !hasServerUrl) return 'choose'
  if (rawWorkMode === 'server' && hasServerUrl) return 'none'
  return 'none'
}
