// Update highlights for this version (shown on the About page).
// Bump `version` and `items` with every release and keep them in sync with CHANGELOG-FORK.md.
// `version` must match the packaged version: the About page only shows the list when it
// matches the running version, which prevents highlights from leaking across releases.
//
// Writing conventions:
// · Order by **importance**: capability gains first, then "no longer tripped up", then polish.
// · One sentence per item. Plain, slightly formal tone, but not stiff:
//     - no marketing voice ("take your pick", "totally lost" style);
//     - not too colloquial either ("way faster", "pops right up", "ping it to check" style);
//     - calibration point: like product release notes, not a chat log and not ad copy.
// · Describe user-visible changes; no module names, field names, or internal words like "refactor".
// · Short but not terse: readable at a glance, yet clear about what it means for the user.
// · Keep the list at 10 items or fewer — a long list has no focus.

import { t } from '@/i18n'

export interface ReleaseHighlights {
  version: string
  items: string[]
}

export const RELEASE_HIGHLIGHTS: ReleaseHighlights = {
  version: '0.2.1',
  // A getter prevents freezing the language at module load; About subscribes to locale
  // changes and re-reads the items on re-render.
  get items() {
    return [
      t('release.0.2.1.1'),
    ]
  },
}
