// Help dialog body for the computer-subtitles page. Opens with what the page does, then
// groups the notes by topic: a small icon per section, dividers between them, and tighter
// gaps than plain paragraphs. The icons mirror the page's visual language — the speaker is
// the audio source, AudioLines is the same mark the sidebar uses for the Voice engine.
// All sentences come from the locale files.

import { Link } from 'react-router-dom'
import { AudioLines, Languages, ShieldCheck, Speaker, Timer } from 'lucide-react'
import { useT } from '@/i18n/useT'
import { HelpSection } from '@/features/settings/HelpSection'

const LINK_CLASS = 'text-foreground underline underline-offset-4'

export default function SystemAudioHelpContent() {
  const t = useT()
  return (
    <div className="divide-y divide-border/60">
      <p className="pb-2 text-sm leading-relaxed text-muted-foreground">{t('systemAudio.helpIntro')}</p>
      <HelpSection icon={Speaker} className="py-2" title={t('systemAudio.helpSourceTitle')}>
        <p>{t('systemAudio.mixHint')}</p>
      </HelpSection>
      <HelpSection icon={Languages} className="py-2" title={t('systemAudio.helpLanguagesTitle')}>
        <p>{t('systemAudio.sourceLanguageHint')}</p>
      </HelpSection>
      <HelpSection icon={Timer} className="py-2" title={t('systemAudio.helpDelayTitle')}>
        <p>{t('systemAudio.delayHint')}</p>
      </HelpSection>
      <HelpSection icon={ShieldCheck} className="py-2" title={t('systemAudio.helpPrivacyTitle')}>
        <p>{t('systemAudio.privacyHint')}</p>
      </HelpSection>
      <HelpSection icon={AudioLines} className="py-2" title={t('systemAudio.helpEngineTitle')}>
        <p>
          {t('systemAudio.engineHint')} <Link to="/voice-engine" className={LINK_CLASS}>{t('nav.voiceEngine')}</Link> / <Link to="/ai-service" className={LINK_CLASS}>{t('nav.aiService')}</Link>
        </p>
      </HelpSection>
    </div>
  )
}
