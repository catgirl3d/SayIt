// @vitest-environment jsdom
import type { ComponentProps } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { t } from '@/i18n'
import { ProfileCard, type ProfileCardAction } from '../ProfileCard'

function action(overrides: Partial<ProfileCardAction> = {}): ProfileCardAction {
  return { ariaLabel: 'action', onClick: vi.fn(), ...overrides }
}

function cardProps(overrides: Partial<ComponentProps<typeof ProfileCard>> = {}): ComponentProps<typeof ProfileCard> {
  return {
    active: false,
    onActivate: vi.fn(),
    ariaLabel: 'DeepSeek Chat card',
    title: 'DeepSeek Chat',
    subtitle: 'api.deepseek.com',
    statusChip: <span>120 ms</span>,
    test: action({ ariaLabel: 'run test' }),
    edit: action({ ariaLabel: 'edit profile' }),
    delete: action({ ariaLabel: 'delete profile' }),
    ...overrides,
  }
}

describe('ProfileCard', () => {
  it('renders the title, subtitle and status chip', () => {
    render(<ProfileCard {...cardProps()} />)

    expect(screen.getByText('DeepSeek Chat')).toBeTruthy()
    const subtitle = screen.getByText('api.deepseek.com')
    expect(subtitle.getAttribute('title')).toBe('api.deepseek.com')
    expect(screen.getByText('120 ms')).toBeTruthy()
    const radio = screen.getByRole('radio')
    expect(radio.getAttribute('aria-label')).toBe('DeepSeek Chat card')
    expect(radio.getAttribute('aria-checked')).toBe('false')
  })

  it('shows the in-use indicator and checked state only when active', () => {
    const { rerender } = render(<ProfileCard {...cardProps()} />)
    expect(screen.queryByLabelText(t('common.inUse'))).toBeNull()

    rerender(<ProfileCard {...cardProps({ active: true })} />)

    expect(screen.getByRole('radio').getAttribute('aria-checked')).toBe('true')
    expect(screen.getByLabelText(t('common.inUse'))).toBeTruthy()
  })

  it('activates on a radio click', () => {
    const onActivate = vi.fn()
    render(<ProfileCard {...cardProps({ onActivate })} />)

    fireEvent.click(screen.getByRole('radio'))

    expect(onActivate).toHaveBeenCalledTimes(1)
  })

  it('calls the matching callback for each action button', () => {
    const test = action({ ariaLabel: 'run test' })
    const edit = action({ ariaLabel: 'edit profile' })
    const deleteAction = action({ ariaLabel: 'delete profile' })
    render(<ProfileCard {...cardProps({ test, edit, delete: deleteAction })} />)

    fireEvent.click(screen.getByLabelText('run test'))
    fireEvent.click(screen.getByLabelText('edit profile'))
    fireEvent.click(screen.getByLabelText('delete profile'))

    expect(test.onClick).toHaveBeenCalledTimes(1)
    expect(edit.onClick).toHaveBeenCalledTimes(1)
    expect(deleteAction.onClick).toHaveBeenCalledTimes(1)
  })

  it('disables the radio and individual actions on request', () => {
    render(
      <ProfileCard
        {...cardProps({
          activateDisabled: true,
          test: action({ ariaLabel: 'run test', disabled: true }),
          edit: action({ ariaLabel: 'edit profile' }),
          delete: action({ ariaLabel: 'delete profile', disabled: true }),
        })}
      />,
    )

    expect((screen.getByRole('radio') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText('run test') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText('edit profile') as HTMLButtonElement).disabled).toBe(false)
    expect((screen.getByLabelText('delete profile') as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps hidden actions out of mouse reach while staying keyboard-revealable', () => {
    const { rerender } = render(<ProfileCard {...cardProps()} />)
    const hiddenContainer = screen.getByLabelText('run test').closest('div')
    expect(hiddenContainer?.className).toContain('opacity-0')
    // An invisible-but-clickable button would swallow clicks meant for the card.
    expect(hiddenContainer?.className).toContain('pointer-events-none')
    // Focus or hover must reveal them, or keyboard users could never reach the actions.
    expect(hiddenContainer?.className).toContain('focus-within:pointer-events-auto')
    expect(hiddenContainer?.className).toContain('group-hover:pointer-events-auto')

    rerender(<ProfileCard {...cardProps({ actionsVisible: true })} />)
    const visibleContainer = screen.getByLabelText('run test').closest('div')
    expect(visibleContainer?.className).toContain('opacity-100')
    expect(visibleContainer?.className).not.toContain('pointer-events-none')
  })

  it('spins the test icon while its action is running', () => {
    const { rerender } = render(
      <ProfileCard {...cardProps({ test: action({ ariaLabel: 'run test', spinning: true }) })} />,
    )
    expect(screen.getByLabelText('run test').querySelector('svg')?.getAttribute('class')).toContain('animate-spin')

    rerender(<ProfileCard {...cardProps({ test: action({ ariaLabel: 'run test' }) })} />)
    expect(screen.getByLabelText('run test').querySelector('svg')?.getAttribute('class') ?? '').not.toContain('animate-spin')
  })

  it('renders children below the subtitle row', () => {
    render(<ProfileCard {...cardProps()}>{<p>Region: China</p>}</ProfileCard>)

    expect(screen.getByText('Region: China')).toBeTruthy()
  })
})
