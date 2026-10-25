import { storeGet } from '@/services/bridge'
import {
  getBackendBaseUrl,
  getStoredBackendBaseUrl,
  resetBackendBaseUrl,
} from '@/services/runtimeConfig'
import { setSetting } from '@/services/store'

export type DefaultServerMigration = 'none' | 'choose'

const MIGRATION_DONE_KEY = 'migration.builtinServerRemoved'

// Earlier builds prefilled this address in the server settings, and "Save and test" stored
// it explicitly, so until this one-time migration is complete a saved address on this host
// means the old built-in default rather than the user's own server. This constant is needed
// only for that migration and can be removed once updates from versions before v0.3.2 are
// no longer supported.
const LEGACY_TRIAL_SERVER_HOST = 'sayitapp.site'

/** Whether a stored URL points at the legacy prefilled server host or one of its subdomains. */
function isLegacyTrialServerUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase()
    return hostname === LEGACY_TRIAL_SERVER_HOST || hostname.endsWith(`.${LEGACY_TRIAL_SERVER_HOST}`)
  } catch {
    return false
  }
}

/** Record that the one-time default-server migration has run. */
export async function completeDefaultServerMigration(): Promise<void> {
  await setSetting(MIGRATION_DONE_KEY, true)
}

/**
 * Decide what to do with users who relied on the old built-in default server.
 *
 * The migration runs once: a stored flag short-circuits it before any address or mode is
 * touched, so an address the user enters later is never mistaken for the old default. On
 * the first run, a stored address on the legacy trial host is removed because older builds
 * saved the prefilled address as if the user had chosen it.
 *
 * These users never touched the mode switcher, so their stored workMode is absent while
 * the saved or built-in server address is still present: keep them on server mode
 * silently. If neither a mode nor an address is available, ask them to choose one. The
 * flag is written only after the migration finishes without a pending choice; if the
 * choice dialog is still due, it appears again on the next launch.
 */
export async function resolveDefaultServerMigration(): Promise<DefaultServerMigration> {
  if ((await storeGet(MIGRATION_DONE_KEY)) === true) return 'none'

  const storedUrl = await getStoredBackendBaseUrl()
  if (isLegacyTrialServerUrl(storedUrl)) await resetBackendBaseUrl()

  const result = await resolveLegacyDefaultServerMigration()
  if (result === 'none') await completeDefaultServerMigration()
  return result
}

async function resolveLegacyDefaultServerMigration(): Promise<DefaultServerMigration> {
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
