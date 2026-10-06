import { Card, CardContent } from '@/components/ui/card'
import SpeechLanguageSelect from '@/components/SpeechLanguageSelect'
import { useT } from '@/i18n/useT'
import type { SpeechInputLanguage } from '@/services/speechInputLanguage'

interface Props {
  value: SpeechInputLanguage
  onChange: (language: SpeechInputLanguage) => void
}

export default function SpeechLanguageSection({ value, onChange }: Props) {
  const t = useT()
  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h2 id="speech-language-heading" className="text-lg font-semibold">
              {t('speechLanguage.title')}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('speechLanguage.note')}</p>
          </div>
          <div className="w-full shrink-0 sm:w-56">
            <SpeechLanguageSelect
              value={value}
              onChange={onChange}
              labelledBy="speech-language-heading"
              className="text-sm [&>button]:h-9"
            />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
