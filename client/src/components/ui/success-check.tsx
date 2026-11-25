import { Check, type LucideProps } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * The "copied / saved" check mark: it draws itself and gives a small pop (see `.success-check`
 * in index.css).
 *
 * Mount it only when the state has **just become a success**: the animation plays once on mount.
 * Keep the call site as a two-way choice, `copied ? <SuccessCheck/> : <Copy/>`, and do not leave
 * it mounted and swap classes instead.
 */
export function SuccessCheck({ className, ...props }: LucideProps) {
  return <Check aria-hidden {...props} className={cn('success-check', className)} />
}
