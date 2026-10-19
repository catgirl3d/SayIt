// AI provider settings page

import AIProviderSection from './AIProviderSection'
import { PageHelp } from './PageHelp'
import { AiServiceHelpContent } from './HelpContents'
import { useT } from '@/i18n/useT'

export default function AIServicePage() {
  const t = useT()
  return (
    <div className="mx-auto max-w-4xl">
      <AIProviderSection
        renderHeader={(actions) => (
          <div className="mb-6 flex items-start justify-between gap-4">
            <div>
              <h1 className="mb-2 text-2xl font-bold">{t('nav.aiService')}</h1>
              <p className="text-sm text-muted-foreground">
                {t('aiService.subtitle')}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {actions}
              <PageHelp title={t('help.aiService.title')}>
                <AiServiceHelpContent />
              </PageHelp>
            </div>
          </div>
        )}
      />
    </div>
  )
}
