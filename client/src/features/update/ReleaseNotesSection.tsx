import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { useLocale, useT } from '@/i18n/useT'
import { formatReleaseDate, type ReleaseNotesVersion } from './changelogHistory'
import { parseReleaseNotes } from './releaseNotes'

interface ReleaseNotesSectionProps {
  versions: ReleaseNotesVersion[]
  value: string
  onChange: (version: string) => void
}

// Stand-in for the version while the title template is split around it; it cannot occur
// in a translation, so the split always lands on the placeholder itself.
const VERSION_SLOT = '\u0000'

/**
 * Presentational "What's new" block: the title, whose version is itself the switcher,
 * and the notes of the selected version. It owns only the scroll/expand state; the
 * version selection is controlled by the caller.
 */
export function ReleaseNotesSection({ versions, value, onChange }: ReleaseNotesSectionProps) {
  const t = useT()
  const locale = useLocale()
  const headingId = useId()
  const selected = versions.find((entry) => entry.version === value)
  const notesMarkdown = selected?.notes ?? ''
  const notes = useMemo(() => parseReleaseNotes(notesMarkdown), [notesMarkdown])

  const notesRef = useRef<HTMLDivElement | null>(null)
  // Store the version the state belongs to instead of a boolean. A version switch is
  // then collapsed immediately on the first render, with no stale expanded paint.
  const [expandedVersion, setExpandedVersion] = useState<string | null>(null)
  const [overflowVersion, setOverflowVersion] = useState<string | null>(null)
  const expanded = expandedVersion === value
  const overflow = overflowVersion === value

  useEffect(() => {
    const element = notesRef.current
    if (!element) {
      setOverflowVersion(null)
      return
    }
    // Measure only while the height cap is applied: an expanded block always fits, so
    // measuring it would report "no overflow" and hide the button that collapses it.
    if (expanded) return
    setOverflowVersion(element.scrollHeight > element.clientHeight + 1 ? value : null)
  }, [value, notesMarkdown, expanded])

  // Local keyboard affordance: the shared Select does not implement arrow navigation
  // over its list yet, so move through the newest-first options without changing it.
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const index = versions.findIndex((entry) => entry.version === value)
    if (index < 0) return
    const next = versions[index + (event.key === 'ArrowDown' ? 1 : -1)]
    if (next) onChange(next.version)
  }

  if (!selected) return null

  const title = t('about.releaseNotes', { version: `v${selected.version}` })
  // The translation decides where the version sits in the title, so the switcher is placed
  // at the placeholder rather than appended after a fixed "What's new in" prefix.
  const [titleBefore, titleAfter = ''] = t('about.releaseNotes', { version: VERSION_SLOT }).split(
    VERSION_SLOT,
  )

  return (
    <div className="mt-5 border-t border-border pt-5">
      {/* The switcher takes its accessible name from its own text (the version) and its
          context from the enclosing heading. Labelling it by the full title would repeat
          the title inside the heading's own accessible name. */}
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 id={headingId} className="min-w-0 text-sm font-medium">
          {versions.length > 1 ? (
            <>
              {titleBefore}
              <span onKeyDown={handleKeyDown}>
                <Select
                  variant="inline"
                  value={value}
                  onChange={onChange}
                  options={versions.map((entry) => ({
                    value: entry.version,
                    label: `v${entry.version}`,
                  }))}
                />
              </span>
              {titleAfter}
            </>
          ) : (
            title
          )}
        </h3>
        {selected.date !== null && (
          <time
            dateTime={selected.date}
            className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground"
          >
            {formatReleaseDate(selected.date, locale)}
          </time>
        )}
      </div>
      {/* Announces a switch made with the arrow keys, which keep focus on the trigger. */}
      {versions.length > 1 && (
        <span role="status" className="sr-only">
          {title}
        </span>
      )}
      <div
        key={value}
        ref={notesRef}
        className={
          expanded
            ? 'space-y-1.5'
            : 'max-h-72 space-y-1.5 overflow-y-auto pr-1'
        }
      >
        {notes.map((block, index) => {
          if (block.kind === 'heading') {
            return (
              <div
                key={index}
                className={
                  block.level === 3
                    ? 'pt-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground/70'
                    : 'pt-1 text-xs font-medium text-muted-foreground'
                }
              >
                {block.text}
              </div>
            )
          }
          if (block.kind === 'bullet') {
            return (
              <div key={index} className="flex gap-2 text-sm text-muted-foreground">
                <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/50" />
                <span>{block.text}</span>
              </div>
            )
          }
          return (
            <p key={index} className="text-sm text-muted-foreground">
              {block.text}
            </p>
          )
        })}
      </div>
      {(overflow || expanded) && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2 h-7 px-2 text-xs text-muted-foreground"
          onClick={() =>
            setExpandedVersion((current) => (current === value ? null : value))
          }
        >
          {expanded ? t('about.collapseNotes') : t('about.showAllNotes')}
        </Button>
      )}
    </div>
  )
}
