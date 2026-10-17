import type { DiagnosticsPreview } from '@/types/appApi'

/**
 * Shared Storybook fixture for the diagnostics preview payload. DiagnosticsPage,
 * DiagnosticsSection, and DiagnosticsReportPanel all consume it so the stories model one
 * backend contract; retentionDays mirrors the real command (commands/diagnostics.rs).
 */
export const diagnosticsPreviewFixture: DiagnosticsPreview = {
  generatedAt: '2026-10-17T13:58:00.000Z',
  retentionDays: 7,
  filesScanned: 6,
  totalRawEvents: 48,
  totalTimelineEntries: 22,
  issueWindowLabel: 'Within the last hour',
  rangeStart: '2026-10-17T12:58:00.000Z',
  rangeEnd: '2026-10-17T13:58:00.000Z',
  systemInfo: { platform: 'windows', appVersion: '0.3.0', webviewVersion: 'WebView2 131' },
  summary: {
    errors: 2,
    warnings: 4,
    modules: [
      { module: 'recorder', count: 14 },
      { module: 'update', count: 8 },
    ],
    lastError: {
      ts: '2026-10-17T13:42:00.000Z',
      level: 'error',
      module: 'recorder',
      title: 'Target application rejected text insertion',
      detail: 'The fallback insertion path was unavailable.',
      traceId: 'storybook-trace-42',
    },
  },
  timeline: [
    {
      ts: '2026-10-17T13:42:00.000Z',
      level: 'error',
      module: 'recorder',
      title: 'Target application rejected text insertion',
      detail: 'The fallback insertion path was unavailable.',
      traceId: 'storybook-trace-42',
    },
    { ts: '2026-10-17T13:20:00.000Z', level: 'warn', module: 'update', title: 'Update check returned an invalid manifest' },
  ],
}
