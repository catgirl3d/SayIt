import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, spyOn, userEvent, waitFor, within } from 'storybook/test'
import { t } from '@/i18n'
import { ReleaseNotesSection } from './ReleaseNotesSection'
import type { ReleaseNotesVersion } from './changelogHistory'

function notesTitle(version: string): string {
  return t('about.releaseNotes', { version: `v${version}` })
}

// The rendered text follows the interface locale, so plays check the machine-readable
// datetime attribute instead of a formatted string.
function releaseDate(canvasElement: HTMLElement): string | null {
  return canvasElement.querySelector('time')?.getAttribute('datetime') ?? null
}

const FIXTURES: ReleaseNotesVersion[] = [
  {
    version: '0.4.0',
    notes: `## v0.4.0

### Added

- Newest bundled note.

#### Details

- A detail of the newest release.`,
    date: '2026-11-26',
  },
  {
    version: '0.3.0',
    notes: `## v0.3.0

### Changed

- Middle bundled note.`,
    date: '2026-10-17',
  },
  {
    // An undated heading: the row shows the title alone.
    version: '0.2.0',
    notes: `## v0.2.0

### Fixed

- Oldest bundled note.`,
    date: null,
  },
]

const LONG_MARKER = 'Long note 40.'

const LONG_NOTES: ReleaseNotesVersion = {
  version: '0.9.0',
  notes: `## v0.9.0

### Added

${Array.from({ length: 40 }, (_, index) => `- Long note ${index + 1}.`).join('\n')}`,
  date: '2026-12-01',
}

const SHORT_NOTES: ReleaseNotesVersion = {
  version: '0.8.0',
  notes: `## v0.8.0

- Short note.`,
  date: '2026-11-01',
}

function ControlledReleaseNotes({
  versions,
  initialVersion,
}: {
  versions: ReleaseNotesVersion[]
  initialVersion: string
}) {
  const [value, setValue] = useState(initialVersion)
  return <ReleaseNotesSection versions={versions} value={value} onChange={setValue} />
}

function isJsdom(): boolean {
  return typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)
}

const meta = {
  title: 'features/update/ReleaseNotesSection',
  component: ReleaseNotesSection,
  args: {
    versions: FIXTURES,
    value: FIXTURES[0].version,
    onChange: () => undefined,
  },
} satisfies Meta<typeof ReleaseNotesSection>

export default meta
type Story = StoryObj<typeof meta>

export const MultipleVersions: Story = {
  render: () => <ControlledReleaseNotes versions={FIXTURES} initialVersion="0.4.0" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    const heading = canvas.getByRole('heading', { name: notesTitle('0.4.0') })
    // The version inside the title is the switcher itself.
    const trigger = within(heading).getByRole('button', { name: 'v0.4.0' })

    await expect(canvas.getByText('Newest bundled note.')).toBeVisible()
    await expect(releaseDate(canvasElement)).toBe('2026-11-26')

    // Keyboard navigation moves to the next older version without opening the list.
    trigger.focus()
    await userEvent.keyboard('{ArrowDown}')
    await expect(within(heading).getByRole('button', { name: 'v0.3.0' })).toBe(trigger)
    await expect(heading).toHaveAccessibleName(notesTitle('0.3.0'))
    await expect(canvas.getByRole('status')).toHaveTextContent(notesTitle('0.3.0'))
    await expect(canvas.getByText('Middle bundled note.')).toBeVisible()
    await expect(canvas.queryByText('Newest bundled note.')).toBeNull()
    // The date follows the selected version.
    await expect(releaseDate(canvasElement)).toBe('2026-10-17')

    await userEvent.click(trigger)
    await userEvent.click(await body.findByRole('button', { name: 'v0.2.0' }))

    await expect(trigger).toHaveTextContent('v0.2.0')
    await expect(canvas.getByText('Oldest bundled note.')).toBeVisible()
    // An undated version leaves no stale date behind.
    await expect(releaseDate(canvasElement)).toBeNull()
    await expect(canvas.queryByText('Middle bundled note.')).toBeNull()
    await expect(canvas.queryByText('Newest bundled note.')).toBeNull()
    await expect(canvas.getByRole('heading', { name: notesTitle('0.2.0') })).toBe(heading)
  },
}

export const SingleVersion: Story = {
  render: () => <ControlledReleaseNotes versions={[FIXTURES[0]]} initialVersion="0.4.0" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    // A single version is plain title text: nothing to switch to, so no trigger.
    const heading = canvas.getByRole('heading', { name: notesTitle('0.4.0') })
    await expect(heading).toBeVisible()
    await expect(within(heading).queryByRole('button')).toBeNull()
    await expect(canvas.queryByRole('status')).toBeNull()
    await expect(canvas.getByText('Newest bundled note.')).toBeVisible()
    // The date sits beside a plain title as well.
    await expect(releaseDate(canvasElement)).toBe('2026-11-26')
    await expect(canvasElement.querySelector('time')).not.toBeEmptyDOMElement()
  },
}

export const LongNotes: Story = {
  render: () => (
    <ControlledReleaseNotes versions={[LONG_NOTES, SHORT_NOTES]} initialVersion="0.9.0" />
  ),
  // jsdom has no layout, so the long fixture would never report overflow there. Stub only
  // the scroller that holds the long fixture; a real browser uses its real geometry.
  beforeEach: () => {
    if (!isJsdom()) return undefined
    const spy = spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(
      function (this: Element) {
        return this.textContent?.includes(LONG_MARKER) ? 1000 : 0
      },
    )
    return () => spy.mockRestore()
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)

    await expect(await canvas.findByText('Long note 1.')).toBeVisible()
    const scroller = canvas.getByText('Long note 1.').parentElement?.parentElement
    await expect(scroller).not.toBeNull()
    await expect(scroller).toHaveClass('max-h-72')

    await userEvent.click(
      await canvas.findByRole('button', { name: t('about.showAllNotes') }),
    )
    await expect(
      await canvas.findByRole('button', { name: t('about.collapseNotes') }),
    ).toBeVisible()
    await expect(scroller).not.toHaveClass('max-h-72')

    await userEvent.click(canvas.getByRole('button', { name: t('about.collapseNotes') }))
    await expect(
      await canvas.findByRole('button', { name: t('about.showAllNotes') }),
    ).toBeVisible()
    await expect(scroller).toHaveClass('max-h-72')

    // Switching from expanded long notes to a short version must collapse the new body
    // and hide the toggle instead of keeping the old expansion state.
    await userEvent.click(canvas.getByRole('button', { name: t('about.showAllNotes') }))
    await userEvent.click(canvas.getByRole('button', { name: 'v0.9.0' }))
    await userEvent.click(await body.findByRole('button', { name: 'v0.8.0' }))

    await expect(await canvas.findByText('Short note.')).toBeVisible()
    await expect(canvas.queryByText('Long note 1.')).toBeNull()
    const shortScroller = canvas.getByText('Short note.').parentElement?.parentElement
    await waitFor(() => expect(shortScroller).toHaveClass('max-h-72'))
    await waitFor(() =>
      expect(canvas.queryByRole('button', { name: t('about.showAllNotes') })).toBeNull(),
    )
    await expect(canvas.queryByRole('button', { name: t('about.collapseNotes') })).toBeNull()
  },
}

export const NoVersions: Story = {
  render: () => <ReleaseNotesSection versions={[]} value="" onChange={() => undefined} />,
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('h3')).toBeNull()
  },
}
