import type { StorybookConfig } from '@storybook/react-vite'

// Storybook mirrors a release build: it must not inherit the dev server address that
// client/.env.development provides for `npm run dev`. Vite and Storybook both give an existing
// process.env value priority over .env files, so an explicit empty value wins.
const nodeProcess = Reflect.get(globalThis, 'process') as { env: Record<string, string | undefined> }
nodeProcess.env.VITE_BACKEND_BASE_URL = ''

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(ts|tsx)'],
  addons: ['@storybook/addon-a11y'],
  framework: '@storybook/react-vite',
  core: {
    disableTelemetry: true,
  },
}

export default config
