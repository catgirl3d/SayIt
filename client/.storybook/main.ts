import type { StorybookConfig } from '@storybook/react-vite'

// ESM-safe file paths from this config's own URL. A Windows file URL pathname starts
// with "/E:/...", so the leading slash before the drive letter is stripped for Vite.
function fileUrlPath(url: URL): string {
  return decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, '$1')
}

const repoRoot = new URL('../..', import.meta.url)
const changelogFiles = ['CHANGELOG.md', 'CHANGELOG.uk.md'].map((name) =>
  fileUrlPath(new URL(name, repoRoot)),
)

// Storybook mirrors a release build: it must not inherit the dev server address that
// client/.env.development provides for `npm run dev`. Vite and Storybook both give an existing
// process.env value priority over .env files, so an explicit empty value wins.
const nodeProcess = Reflect.get(globalThis, 'process') as { env: Record<string, string | undefined> }
nodeProcess.env.VITE_BACKEND_BASE_URL = ''
// SAYIT_DEFAULT_SERVER_URL is cleared too, so a value exported in the developer's shell does not
// give the stories a built-in default server.
nodeProcess.env.SAYIT_DEFAULT_SERVER_URL = ''

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-a11y'],
  framework: '@storybook/react-vite',
  core: {
    disableTelemetry: true,
  },
  // Storybook's Vite dev server builds a fresh `server` block and does not inherit the app's
  // server.fs.allow, so the About page's bundled ?raw changelog imports would be denied. Allow
  // exactly those two files and their query ids, not the repository root.
  viteFinal: (viteConfig) => {
    viteConfig.server ??= {}
    viteConfig.server.fs ??= {}
    viteConfig.server.fs.allow = [
      ...(viteConfig.server.fs.allow ?? []),
      // Setting fs.allow replaces Vite's default project-root entry; keep that root so
      // Storybook's own source modules stay served.
      ...(viteConfig.root ? [viteConfig.root] : []),
      ...changelogFiles,
      ...changelogFiles.map((file) => `${file}?raw`),
    ]
    return viteConfig
  },
}

export default config
