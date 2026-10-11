/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'

const host = process.env.TAURI_DEV_HOST
const defaultServerUrl = process.env.SAYIT_DEFAULT_SERVER_URL || 'https://sayitapp.site'

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
