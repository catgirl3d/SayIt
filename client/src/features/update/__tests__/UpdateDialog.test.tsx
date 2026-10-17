// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '@/i18n'
import type { AutoUpdateState } from '../autoUpdate'

const autoUpdate = vi.hoisted(() => ({
  state: { phase: 'idle' } as AutoUpdateState,
}))

vi.mock('../autoUpdate', () => ({
  getAutoUpdateState: () => autoUpdate.state,
  onAutoUpdateChange: () => () => undefined,
}))

import UpdateDialog from '../UpdateDialog'

describe('UpdateDialog', () => {
  beforeEach(() => {
    autoUpdate.state = { phase: 'idle' }
  })

  it('renders nothing outside the installing phase', () => {
    autoUpdate.state = { phase: 'downloading' }

    const { container } = render(<UpdateDialog />)

    expect(container.firstChild).toBeNull()
  })

  it('announces the installing overlay as an alert dialog and takes focus', () => {
    autoUpdate.state = { phase: 'installing', versionInfo: { latestVersion: '1.2.3' } as AutoUpdateState['versionInfo'] }

    render(<UpdateDialog />)

    const dialog = screen.getByRole('alertdialog', { name: t('update.installingTitle', { version: '1.2.3' }) })
    const describedBy = dialog.getAttribute('aria-describedby')
    expect(document.getElementById(describedBy as string)?.textContent).toBe(t('update.installingDesc'))
    expect(document.activeElement).toBe(dialog)
  })
})
