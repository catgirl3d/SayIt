import { startWebviewKeyboardFallback } from './services/webviewKeyboardFallback'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import './index.css'
import './app-scrollbar.css'
import { addRuntimeEvent } from './services/debugLog'
import { resolveDefaultServerMigration } from './services/defaultServerMigration'
import { initRuntimeConfig } from './services/runtimeConfig'
import { initProviderFromStore } from './services/transcription'
import { initLanguage, initLocaleDefaults } from './stores/language'
import { initSpeechInputLanguageMigration } from './services/speechInputLanguage'

window.addEventListener('error', (event) => {
  addRuntimeEvent('error', 'window', event.message || 'Uncaught error', {
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
  })
})

window.addEventListener('unhandledrejection', (event) => {
  addRuntimeEvent('error', 'promise', 'Unhandled promise rejection', {
    reason: String(event.reason),
  })
})

async function bootstrap() {
  let runtimeConfigReady = false
  let needsWorkModeChoice = false
  try {
    await initRuntimeConfig()
    runtimeConfigReady = true
  } catch (e) {
    console.error('[bootstrap] initRuntimeConfig error:', e)
  }
  try {
    const locale = await initLanguage()
    await initLocaleDefaults(locale)
  } catch (e) {
    console.error('[bootstrap] initLanguage error:', e)
  }
  try {
    await initSpeechInputLanguageMigration()
  } catch (e) {
    console.error('[bootstrap] initSpeechInputLanguageMigration error:', e)
  }
  if (runtimeConfigReady) {
    try {
      needsWorkModeChoice = (await resolveDefaultServerMigration()) === 'choose'
    } catch (e) {
      console.error('[bootstrap] resolveDefaultServerMigration error:', e)
    }
    try {
      await initProviderFromStore()
    } catch (e) {
      console.error('[bootstrap] initProviderFromStore error:', e)
    }
  } else {
    console.error('[bootstrap] initProviderFromStore skipped: runtime config is not ready')
  }
  try {
    void startWebviewKeyboardFallback()
  } catch (e) {
    console.error('[bootstrap] startWebviewKeyboardFallback error:', e)
  }

  const rootEl = document.getElementById('root')
  if (rootEl) {
    ReactDOM.createRoot(rootEl).render(
      <HashRouter>
        <App runtimeConfigReady={runtimeConfigReady} needsWorkModeChoice={needsWorkModeChoice} />
      </HashRouter>,
    )
  }
}

void bootstrap()
