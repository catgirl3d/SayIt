import '../src/index.css'
import '../src/app-scrollbar.css'
import { useLayoutEffect, useState, type ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import type { Decorator, Preview } from '@storybook/react-vite'
import { applyTheme, getTheme, themeList } from '@/themes'
import { isLocale, LOCALES, setLocale, type Locale } from '@/i18n'
import { cleanupTauriStory, installTauriBootstrap, tauriBeforeEach } from '@/storybook/tauriMock'

installTauriBootstrap()

type RouterParameter = false | { initialEntries?: string[] }

function applyEnvironment(themeId: string, locale: Locale): void {
  const appliedThemeId = applyTheme(themeId)
  setLocale(locale)
  const theme = getTheme(appliedThemeId)
  document.body.style.backgroundColor = `hsl(${theme.vars['--background']})`
  document.body.style.color = `hsl(${theme.vars['--foreground']})`
}

function Environment({ themeId, locale, children }: { themeId: string; locale: Locale; children: ReactNode }) {
  const [ready, setReady] = useState(false)

  useLayoutEffect(() => {
    applyEnvironment(themeId, locale)
    setReady(true)
  }, [locale, themeId])

  return ready ? children : null
}

const withEnvironment: Decorator = (Story, context) => {
  const themeId = typeof context.globals.theme === 'string' ? context.globals.theme : 'light'
  const locale = isLocale(context.globals.locale) ? context.globals.locale : 'en'
  return (
    <Environment themeId={themeId} locale={locale}>
      <Story />
    </Environment>
  )
}

const withRouter: Decorator = (Story, context) => {
  const router = context.parameters.router as RouterParameter | undefined
  if (router === false) return <Story />
  return <MemoryRouter initialEntries={router?.initialEntries ?? ['/']}><Story /></MemoryRouter>
}

const preview: Preview = {
  globalTypes: {
    theme: {
      name: 'Theme',
      description: 'Preview theme',
      toolbar: {
        icon: 'paintbrush',
        items: themeList.map((theme) => ({ value: theme.id, title: theme.name })),
      },
    },
    locale: {
      name: 'Locale',
      description: 'Preview locale',
      toolbar: {
        icon: 'globe',
        items: LOCALES.map((locale) => ({ value: locale, title: locale.toUpperCase() })),
      },
    },
  },
  initialGlobals: {
    theme: 'light',
    locale: 'en',
  },
  beforeEach: tauriBeforeEach,
  afterEach: () => cleanupTauriStory(),
  decorators: [withEnvironment, withRouter],
}

export default preview
