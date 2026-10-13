// Help dialog body for the computer-subtitles page: the explanatory notes that used to sit
// under the settings card. All sentences come from the locale files.

import { Link } from 'react-router-dom'
import { useT } from '@/i18n/useT'

const LINK_CLASS = 'text-foreground underline underline-offset-4'

export default function SystemAudioHelpContent() {
  const t = useT()
  return (
    <div className="space-y-3 text-sm leading-relaxed text-muted-foreground">
      <p>
        {t('systemAudio.engineHint')} <Link to="/voice-engine" className={LINK_CLASS}>{t('nav.voiceEngine')}</Link> / <Link to="/ai-service" className={LINK_CLASS}>{t('nav.aiService')}</Link>
      </p>
      <p>{t('systemAudio.sourceLanguageHint')}</p>
      <p>{t('systemAudio.mixHint')}</p>
      <p>{t('systemAudio.delayHint')}</p>
      <p>{t('systemAudio.privacyHint')}</p>
    </div>
  )
}
