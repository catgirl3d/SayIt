// Shared class strings for the Settings profile editors. Extracted verbatim from
// AIProviderSection / CloudAPISection, which had byte-identical copies.
// Pointer-events for icon buttons is deliberately NOT set here: the ProfileCard action
// container owns that gate so hidden actions stay out of mouse reach.

export const inputClass = 'h-9 w-full rounded-md border border-input-border bg-input-bg px-3 text-sm transition-colors focus:border-input-focus-border'

export const linkClass = 'inline-flex items-center gap-1 text-xs text-primary underline underline-offset-2 decoration-primary/40 transition-colors hover:decoration-primary'

export const cardIconButtonClass = 'rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40'

export const helpIconClass = 'h-3.5 w-3.5 shrink-0 cursor-help text-muted-foreground/50 transition-colors hover:text-muted-foreground'
