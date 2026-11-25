import { storeGet } from '@/services/bridge'
import { isLegacyTrialServerUrl } from '@/services/legacyServer'
import {
  discardBackendBaseUrlForSession,
  getBackendBaseUrl,
  getStoredBackendBaseUrl,
  resetBackendBaseUrl,
} from '@/services/runtimeConfig'
import { setSetting } from '@/services/store'

export type DefaultServerMigration = 'none' | 'choose'

const MIGRATION_DONE_KEY = 'migration.builtinServerRemoved'

// Earlier builds prefilled the upstream trial address in the server settings, and "Save and
// test" stored it explicitly. The fork never runs that server, so a saved address on the
// legacy host is removed at every start, not only during the one-time migration that the
// completion flag records. The flag says the mode migration has run; it never re-enables
// the legacy host.

/**
 * Record that the one-time default-server migration has run. The choice dialog is shown
 * when an earlier attempt to delete the legacy address failed, so the address may still be
 * stored: retry the removal first and let a failure propagate, leaving the flag unwritten
 * so the next launch runs the migration again.
 */
export async function completeDefaultServerMigration(): Promise<void> {
  if (isLegacyTrialServerUrl(await getStoredBackendBaseUrl())) {
    await resetBackendBaseUrl()
  }
  await setSetting(MIGRATION_DONE_KEY, true)
}

/**
 * Decide what to do with users who relied on the old built-in default server.
 *
 * Every start reads the completion flag and the saved address first: a saved address on
 * the legacy trial host is removed even after the migration completed, because this fork
 * must never contact that server. If the flag cannot be read, an active legacy address is
 * dropped and the error propagates so startup fails closed. If the saved address cannot be
 * read, an active legacy address is dropped; after completion the migration finishes quietly,
 * before completion the error propagates, and a valid own server is never dropped.
 *
 * When removal succeeds and the migration already ran, the session continues without
 * writing any setting. If removal fails, the active address is dropped for this session:
 * a completed migration finishes quietly and leaves its flag unchanged, while an unfinished
 * one keeps the flag unwritten and asks for a work mode unless local or cloud_api is
 * already saved.
 *
 * On the first run, these users never touched the mode switcher, so their stored workMode is
 * absent while the saved or built-in server address is still present: keep them on server
 * mode silently. If neither a mode nor an address is available, ask them to choose one. The
 * flag is written only after the migration finishes without a pending choice; if the
 * choice dialog is still due, it appears again on the next launch.
 */
export async function resolveDefaultServerMigration(): Promise<DefaultServerMigration> {
  let migrationDone: boolean
  try {
    migrationDone = (await storeGet(MIGRATION_DONE_KEY)) === true
  } catch (error) {
    console.error('[defaultServerMigration] Failed to read the migration flag:', error)
    if (isLegacyTrialServerUrl(getBackendBaseUrl())) {
      await discardBackendBaseUrlForSession()
    }
    throw error
  }

  let storedUrl: string
  try {
    storedUrl = await getStoredBackendBaseUrl()
  } catch (error) {
    console.error('[defaultServerMigration] Failed to read the saved server address:', error)
    if (isLegacyTrialServerUrl(getBackendBaseUrl())) {
      await discardBackendBaseUrlForSession()
    }
    if (!migrationDone) throw error
    return 'none'
  }

  if (isLegacyTrialServerUrl(storedUrl)) {
    try {
      await resetBackendBaseUrl()
    } catch (error) {
      console.error('[defaultServerMigration] Failed to remove the legacy server address:', error)
      await discardBackendBaseUrlForSession()
      if (migrationDone) return 'none'
      const rawWorkMode = await storeGet('workMode')
      return rawWorkMode === 'local' || rawWorkMode === 'cloud_api' ? 'none' : 'choose'
    }
  }

  if (migrationDone) return 'none'

  const result = await resolveLegacyDefaultServerMigration()
  if (result === 'none') await completeDefaultServerMigration()
  return result
}

/**
 * Startup wrapper: an unexpected migration failure must fail closed by showing the mode
 * dialog. A failed legacy-address deletion is already contained by dropping the active
 * address for this session and is handled inside resolveDefaultServerMigration.
 */
export async function needsWorkModeChoiceAtStartup(): Promise<boolean> {
  try {
    return (await resolveDefaultServerMigration()) === 'choose'
  } catch (error) {
    console.error('[bootstrap] resolveDefaultServerMigration error:', error)
    return true
  }
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
