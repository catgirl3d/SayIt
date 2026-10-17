import type { Meta, StoryObj } from '@storybook/react-vite'
import { CheckCircle2 } from 'lucide-react'
import { ProfileCard } from './ProfileCard'

const meta = {
  title: 'settings/ProfileCard',
  component: ProfileCard,
} satisfies Meta<typeof ProfileCard>

export default meta
type Story = StoryObj<typeof meta>

const baseArgs = {
  active: false,
  onActivate: () => undefined,
  ariaLabel: 'Profile',
  title: 'Profile',
  subtitle: 'Model',
  statusChip: null,
  test: { ariaLabel: 'Test profile', onClick: () => undefined },
  edit: { ariaLabel: 'Edit profile', onClick: () => undefined },
  delete: { ariaLabel: 'Delete profile', onClick: () => undefined },
} satisfies Parameters<typeof ProfileCard>[0]

export const ActiveAvailable: Story = {
  args: baseArgs,
  render: () => (
    <div className="w-full max-w-sm">
      <ProfileCard
        active
        onActivate={() => undefined}
        ariaLabel="OpenAI transcription profile, available"
        title="OpenAI transcription"
        subtitle="gpt-4o-mini-transcribe"
        statusChip={<span className="rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success-strong">Available</span>}
        test={{ ariaLabel: 'Test OpenAI transcription', onClick: () => undefined }}
        edit={{ ariaLabel: 'Edit OpenAI transcription', onClick: () => undefined }}
        delete={{ ariaLabel: 'Delete OpenAI transcription', onClick: () => undefined }}
      >
        <p className="mt-1 text-[11px] leading-snug text-muted-foreground">Global endpoint · verified 420 ms ago</p>
      </ProfileCard>
    </div>
  ),
}

export const NeedsSetup: Story = {
  args: baseArgs,
  render: () => (
    <div className="w-full max-w-sm">
      <ProfileCard
        active={false}
        onActivate={() => undefined}
        ariaLabel="Qwen realtime profile, needs setup"
        title="Qwen realtime"
        subtitle="qwen3-asr-flash-realtime"
        actionsVisible
        statusChip={<span className="rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning-strong">Needs setup</span>}
        test={{ ariaLabel: 'Test Qwen realtime', onClick: () => undefined }}
        edit={{ ariaLabel: 'Edit Qwen realtime', onClick: () => undefined }}
        delete={{ ariaLabel: 'Delete Qwen realtime', onClick: () => undefined }}
      >
        <p className="mt-1 text-[11px] leading-snug text-muted-foreground">The business workspace ID is still missing.</p>
      </ProfileCard>
    </div>
  ),
}

export const DisabledActions: Story = {
  args: baseArgs,
  render: () => (
    <div className="w-full max-w-sm">
      <ProfileCard
        active={false}
        onActivate={() => undefined}
        activateDisabled
        ariaLabel="Profile activation pending"
        title="DeepSeek"
        subtitle="deepseek-v4-flash"
        statusChip={<span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"><CheckCircle2 className="h-3 w-3" />Testing</span>}
        test={{ ariaLabel: 'Test DeepSeek', onClick: () => undefined, disabled: true, spinning: true }}
        edit={{ ariaLabel: 'Edit DeepSeek', onClick: () => undefined, disabled: true }}
        delete={{ ariaLabel: 'Delete DeepSeek', onClick: () => undefined, disabled: true }}
      />
    </div>
  ),
}
