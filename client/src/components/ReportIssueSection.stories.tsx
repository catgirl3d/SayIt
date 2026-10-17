import type { Meta, StoryObj } from '@storybook/react-vite'
import ReportIssueSection from './ReportIssueSection'

const meta = {
  title: 'components/ReportIssueSection',
  component: ReportIssueSection,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof ReportIssueSection>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
