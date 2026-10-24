import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface Capability {
  identifier: string
  windows: string[]
  permissions: string[]
}

interface TauriConfig {
  app: {
    security: {
      csp: string | null
      devCsp: string | null
      dangerousDisableAssetCspModification?: boolean | string[]
    }
  }
}

const testsDir = dirname(fileURLToPath(import.meta.url))
const srcTauriDir = join(testsDir, '..', 'src-tauri')
const capabilitiesDir = join(srcTauriDir, 'capabilities')

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T
}

function cspSources(csp: string, directive: string): string[] {
  const entry = csp
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${directive} `))
  return entry ? entry.split(/\s+/).slice(1) : []
}

describe('Tauri security configuration', () => {
  const config = readJson<TauriConfig>(join(srcTauriDir, 'tauri.conf.json'))
  const security = config.app.security
  const csp = security.csp ?? ''
  const capabilities = readdirSync(capabilitiesDir)
    .filter((fileName) => fileName.endsWith('.json'))
    .map((fileName) => readJson<Capability>(join(capabilitiesDir, fileName)))
  const byIdentifier = new Map(capabilities.map((capability) => [capability.identifier, capability]))
  const allPermissions = capabilities.flatMap((capability) => capability.permissions)

  it('keeps a production CSP with only the script sources the app needs', () => {
    expect(security.csp, 'app.security.csp must not be null').not.toBeNull()
    expect(cspSources(csp, 'default-src')).toEqual(["'self'"])
    // The AudioWorklet has data- and blob-URL fallbacks, so those sources stay.
    expect(cspSources(csp, 'script-src')).toEqual(["'self'", 'blob:', 'data:'])
    expect(cspSources(csp, 'object-src')).toEqual(["'none'"])
    expect(cspSources(csp, 'base-uri')).toEqual(["'self'"])
    expect(cspSources(csp, 'form-action')).toEqual(["'none'"])
    expect(cspSources(csp, 'frame-src')).toEqual(["'none'"])
    expect(cspSources(csp, 'img-src')).not.toContain('https:')
    expect(cspSources(csp, 'connect-src')).toEqual(
      expect.arrayContaining(["'self'", 'ipc:', 'http://ipc.localhost']),
    )
  })

  it('does not disable Tauri script CSP injection', () => {
    const disabled = security.dangerousDisableAssetCspModification
    expect(disabled === true).toBe(false)
    if (Array.isArray(disabled)) expect(disabled).not.toContain('script-src')
  })

  it('only grants the event API to every window', () => {
    expect([...byIdentifier.keys()].sort()).toEqual(['default', 'main-window'])
    expect(byIdentifier.get('default')).toMatchObject({
      windows: ['main', 'overlay', 'tray-menu'],
      permissions: ['core:event:default'],
    })
  })

  it('keeps window controls, dialogs and shell links on the main window only', () => {
    expect(byIdentifier.get('main-window')).toMatchObject({
      windows: ['main'],
      permissions: [
        'core:window:allow-minimize',
        'core:window:allow-toggle-maximize',
        'core:window:allow-close',
        'shell:allow-open',
        'dialog:allow-open',
        'dialog:allow-save',
      ],
    })
  })

  it('does not reintroduce broad or Rust-only plugin permissions', () => {
    for (const permission of [
      'core:default',
      'core:window:default',
      'core:webview:default',
      'dialog:default',
      'fs:default',
      'fs:allow-write-file',
      'clipboard-manager:default',
      'autostart:default',
      'global-shortcut:default',
      'shell:allow-execute',
      'shell:allow-spawn',
      'shell:allow-kill',
    ]) {
      expect(allPermissions).not.toContain(permission)
    }
  })
})
