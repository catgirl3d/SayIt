import { Select } from '@/components/ui/select'
import { useT } from '@/i18n/useT'
import type { TranslationKey } from '@/i18n'
import { SPEECH_INPUT_LANGUAGES, type SpeechInputLanguage } from '@/services/speechInputLanguage'

interface Props {
  value: SpeechInputLanguage
  onChange: (value: SpeechInputLanguage) => void
  labelledBy?: string
  disabled?: boolean
  className?: string
}

const LANGUAGE_LABELS: Record<SpeechInputLanguage, TranslationKey> = {
  auto: 'common.auto',
  ru: 'local.lang.ru',
  uk: 'local.lang.uk',
  en: 'local.lang.en',
  zh: 'local.lang.zh',
}

export default function SpeechLanguageSelect({ value, onChange, labelledBy, disabled, className }: Props) {
  const t = useT()
  return (
    <Select
      value={value}
      onChange={(selected) => onChange(selected as SpeechInputLanguage)}
      options={SPEECH_INPUT_LANGUAGES.map((language) => ({ value: language, label: t(LANGUAGE_LABELS[language]) }))}
      labelledBy={labelledBy}
      disabled={disabled}
      className={className}
    />
  )
}
