import { cn } from '@/lib/utils'
import type { SystemAudioState } from '@/services/systemAudio'

// One color per session state, shared by the page and the sidebar entry so the two never disagree.
// Only the states that are still moving pulse: listening (captions keep arriving) and the two
// transitions; paused and error hold still because nothing happens until the user acts.
const DOT_CLASS: Record<SystemAudioState, string> = {
  idle: 'bg-muted-foreground/50',
  starting: 'bg-muted-foreground animate-pulse',
  listening: 'bg-success animate-pulse',
  paused: 'bg-warning',
  stopping: 'bg-muted-foreground animate-pulse',
  error: 'bg-destructive',
}

/** Decorative: callers carry the state in text next to the dot. */
export default function SessionStatusDot({ state, className }: { state: SystemAudioState; className?: string }) {
  return <span aria-hidden className={cn('inline-block h-2 w-2 shrink-0 rounded-full', DOT_CLASS[state], className)} />
}
