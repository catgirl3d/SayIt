import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

interface HelpSectionProps {
  title: string
  /** Small decorative marker before the heading; the title carries the meaning. */
  icon?: LucideIcon
  className?: string
  children: ReactNode
}

// Titled block of a page-help dialog: one heading, then paragraphs. Shared by the Voice
// engine, AI providers, and Computer subtitles help bodies so every help dialog reads
// with the same rhythm.
export function HelpSection({ title, icon: Icon, className, children }: HelpSectionProps) {
  return (
    <section className={className}>
      <h4 className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-foreground">
        {Icon && <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />}
        {title}
      </h4>
      <div className="space-y-1.5 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </section>
  )
}
