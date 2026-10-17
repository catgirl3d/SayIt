import type { Meta, StoryObj } from '@storybook/react-vite'
import { Card, CardContent, CardHeader, CardTitle } from './card'

const meta = {
  title: 'ui/card',
  component: Card,
  parameters: {
    layout: 'centered',
  },
} satisfies Meta<typeof Card>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Transcription settings</CardTitle>
        <p className="text-sm text-muted-foreground">Choose how SayIt handles the next recording.</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2 text-sm">
          <span>Processing mode</span>
          <span className="font-medium">Local</span>
        </div>
        <p className="text-xs text-muted-foreground">The selected model stays on this device.</p>
      </CardContent>
    </Card>
  ),
}

export const ContentOnly: Story = {
  render: () => (
    <Card className="w-full max-w-sm">
      <CardContent className="p-4">
        <p className="text-sm font-medium">No recent recordings</p>
        <p className="mt-1 text-xs text-muted-foreground">Start dictation to see your history here.</p>
      </CardContent>
    </Card>
  ),
}
