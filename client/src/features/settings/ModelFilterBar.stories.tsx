import type { Meta, StoryObj } from '@storybook/react-vite'
import { ModelFilterBar, ModelFilterEmptyState } from './ModelFilterBar'

const meta = {
  title: 'settings/ModelFilterBar',
  component: ModelFilterBar,
} satisfies Meta<typeof ModelFilterBar>

export default meta
type Story = StoryObj<typeof meta>

const baseArgs = {
  tab: 'all' as const,
  onTabChange: () => undefined,
  searchQuery: '',
  onSearchQueryChange: () => undefined,
  totalCount: 12,
  downloadedCount: 4,
} satisfies Parameters<typeof ModelFilterBar>[0]

function renderBar(tab: 'all' | 'downloaded', searchQuery: string, empty = false) {
  return (
    <div className="w-full max-w-2xl rounded-lg border border-border bg-card p-5">
      <ModelFilterBar
        tab={tab}
        onTabChange={() => undefined}
        searchQuery={searchQuery}
        onSearchQueryChange={() => undefined}
        totalCount={12}
        downloadedCount={4}
      />
      {empty && (
        <ModelFilterEmptyState
          tab={tab}
          downloadedCount={tab === 'downloaded' ? 0 : 4}
          searchQuery={searchQuery}
          onSwitchToAll={() => undefined}
          onClearFilters={() => undefined}
        />
      )}
    </div>
  )
}

export const AllModels: Story = {
  args: baseArgs,
  render: () => renderBar('all', ''),
}

export const DownloadedModels: Story = {
  args: baseArgs,
  render: () => renderBar('downloaded', ''),
}

export const SearchNoMatch: Story = {
  args: baseArgs,
  render: () => renderBar('all', 'meeting-notes', true),
}

export const NoDownloadedModels: Story = {
  args: baseArgs,
  render: () => renderBar('downloaded', '', true),
}
