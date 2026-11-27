/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'
import { CHANGELOG_FILES } from './changelogFiles'

const host = process.env.TAURI_DEV_HOST
// client/src-tauri/build.rs reads the same env var so the Rust TLS policy protects the same host.
// It is optional: an empty value means the build has no built-in server.
const defaultServerUrl = process.env.SAYIT_DEFAULT_SERVER_URL?.trim() || ''

// Read the version from tauri.conf.json
const tauriConf = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'src-tauri/tauri.conf.json'), 'utf-8')
)
// SAYIT_FAKE_APP_VERSION exists only to test auto-update on a real machine.
// It lowers the version the frontend reports (e.g. to 0.1.5), so the online manifest's
// 0.1.6 becomes a "new version" and the entire chain (check → download → SHA-512
// verification → reminder icon → install) can be exercised for real without publishing
// a fake build first. Auto-update must be tested before a release (see
// .kiro/steering/pitfalls.md #3), and updater changes cannot verify themselves — this
// escape hatch is the entry point for that verification.
// Production builds never set this variable; when set, it prints a conspicuous warning.
const fakeVersion = process.env.SAYIT_FAKE_APP_VERSION
if (fakeVersion) {
  console.warn(`\n[vite] SAYIT_FAKE_APP_VERSION=${fakeVersion} — 应用会自报这个版本（真实版本 ${tauriConf.version}）。仅用于测更新，别拿来打包。\n`)
}
const appVersion = fakeVersion || tauriConf.version || '0.0.0'

export default defineConfig({
  define: {
    __SAYIT_DEFAULT_SERVER_URL__: JSON.stringify(defaultServerUrl),
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // Vite options tailored for Tauri development
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    // The PCM worklet is shared with the web client under server/web, outside this Vite root.
    // Vite enforces server.fs.allow for ?raw imports, and a custom allow list replaces the default.
    // The About page also bundles the two root changelogs with ?raw; allow exactly those files,
    // not the whole repository root. Vite checks a ?raw import under both its clean file path and
    // its id with the query, so the query form must be listed as well; this still allows only the
    // two files.
    fs: {
      allow: [
        __dirname,
        path.resolve(__dirname, '..', 'server', 'web'),
        ...CHANGELOG_FILES.flatMap((name) => {
          const file = path.resolve(__dirname, '..', name)
          return [file, `${file}?raw`]
        }),
      ],
    },
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  test: {
    globals: true,
    environment: 'node',
    // tests/ holds suites that need Node built-ins (e.g. the release generator
    // contract test); src/ is the default home for app tests.
    include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.ts'],
  },
  build: {
    // Production builds strip console.log and debugger (console.warn/error are kept)
    minify: 'esbuild',
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        overlay: path.resolve(__dirname, 'overlay.html'),
        trayMenu: path.resolve(__dirname, 'tray-menu.html'),
      },
    },
  },
  esbuild: {
    drop: ['debugger'],
    pure: ['console.log'],
  },
})
