// "Inject hotwords into the prompt" toggle card
// When enabled, the AI cleanup stage injects the user's hotword list into the system prompt to help
// correct or preserve proper nouns. Off by default.

import { useEffect, useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { getSetting, setSetting } from '@/services/store'
import { useAiEnabled, useAiEnabledReady } from '@/hooks/useAiEnabled'
import { useT } from '@/i18n/useT'

export default function HotwordPromptInjectToggle() {
  const t = useT()
  const aiEnabled = useAiEnabled()
  const aiReady = useAiEnabledReady()
  const aiInactive = aiReady && !aiEnabled
  const [enabled, setEnabled] = useState(false)
  // Until the saved value is read, keep the switch hidden and animation-free: this avoids drawing
  // the default and then jumping to the saved value (a flash). The finally block is a fallback:
  // even a failed read reveals the switch showing the default instead of leaving it hidden forever.
  const [ready, setReady] = useState(false)
  // animate is separate from ready: ready controls when the switch is revealed, animate controls
  // when transitions are allowed. If the transition is restored in the same frame as the reveal or
  // the value assignment, CSS sees "a transition exists and the value changed" and actually
  // animates the default-to-saved change (which looks like a flash). The reveal frame therefore
  // stays transition-free; transitions are enabled two frames later, once the value is stable.
  const [animate, setAnimate] = useState(false)

  useEffect(() => {
    getSetting('injectHotwordsToPrompt', false)
      .then((v) => setEnabled(Boolean(v)))
      .finally(() => {
        setReady(true)
        requestAnimationFrame(() => requestAnimationFrame(() => setAnimate(true)))
      })
  }, [])

  const toggle = () => {
    const next = !enabled
    setEnabled(next)
    void setSetting('injectHotwordsToPrompt', next)
  }

  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <div className="pr-4">
            <h2 id="hotword-inject-heading" className={`text-lg font-semibold ${aiInactive ? 'text-muted-foreground' : ''}`}>{t('hotwordInject.title')}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('hotwordInject.desc')}
            </p>
            {aiInactive && (
              <p className="mt-1 text-xs text-muted-foreground/80">
                {t('hotwordInject.disabledReason')}
              </p>
            )}
          </div>
          {/* Keep the saved choice visible; only applying it is blocked. AI off must not
              look like the user turned this off, and turning AI back on restores the choice. */}
          <Switch
            checked={enabled}
            onChange={toggle}
            disabled={aiInactive}
            labelledBy="hotword-inject-heading"
            noAnimation={!animate}
            hidden={!ready}
          />
        </div>
      </CardContent>
    </Card>
  )
}
