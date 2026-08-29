import { useEffect, useSyncExternalStore } from 'react'
import { NavLink } from 'react-router-dom'
import {
  Home,
  Clock,
  BookOpen,
  AudioLines,
  Sparkles,
  Wand2,
  Mic,
  Keyboard,
  Sliders,
  Palette,
  BarChart3,
  Stethoscope,
  Info,
  Wifi,
  WifiOff,
  Cpu,
  Cloud,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Tooltip } from '@/components/ui/tooltip'
import { useConnectionStatus } from '@/hooks/useConnectionStatus'
import { getModeStatus, refreshModeStatus, subscribeModeStatus } from '@/stores/modeStatus'
import { hasPendingUpdate } from '@/features/update/autoUpdate'
import { useUpdateState } from '@/features/update/useUpdateState'
import type { TranslationKey } from '@/i18n'
import { useT } from '@/i18n/useT'

interface NavItemDef {
  to: string
  icon: typeof Home
  labelKey: TranslationKey
}

/**
 * Navigation items store i18n keys instead of literal text:
 * When changing languages, module-level string constants are evaluated only once.
 * Storing i18n translation keys ensures navigation labels react dynamically to language switches.
 */
const workspaceNavItems = [
  { to: '/', icon: Home, labelKey: 'nav.home' },
  { to: '/history', icon: Clock, labelKey: 'nav.history' },
  { to: '/hotwords', icon: BookOpen, labelKey: 'nav.hotwords' },
] as const satisfies readonly NavItemDef[]

const aiNavItems = [
  { to: '/voice-engine', icon: AudioLines, labelKey: 'nav.voiceEngine' },
  { to: '/ai-service', icon: Sparkles, labelKey: 'nav.aiService' },
  { to: '/ai-instructions', icon: Wand2, labelKey: 'nav.aiInstructions' },
] as const satisfies readonly NavItemDef[]

const systemNavItems = [
  { to: '/audio', icon: Mic, labelKey: 'nav.audio' },
  { to: '/shortcuts', icon: Keyboard, labelKey: 'nav.shortcuts' },
  { to: '/general', icon: Sliders, labelKey: 'nav.general' },
  { to: '/appearance', icon: Palette, labelKey: 'nav.appearance' },
  { to: '/usage', icon: BarChart3, labelKey: 'nav.personalization' },
  { to: '/diagnostics', icon: Stethoscope, labelKey: 'nav.diagnostics' },
] as const satisfies readonly NavItemDef[]

const footerNavItems = [
  { to: '/about', icon: Info, labelKey: 'nav.about' },
] as const satisfies readonly NavItemDef[]

function NavItem({
  to,
  icon: Icon,
  label,
}: {
  to: string
  icon: typeof Home
  label: string
}) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs transition-colors',
          isActive
            ? 'bg-sidebar-item-active font-medium text-sidebar-text-active'
            : 'text-sidebar-text hover:bg-sidebar-item-hover hover:text-sidebar-text-active',
        )
      }
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">{label}</span>
    </NavLink>
  )
}

function IconOnlyNavItem({
  to,
  icon: Icon,
  label,
  iconClassName,
}: {
  to: string
  icon: typeof Home
  label: string
  iconClassName?: string
}) {
  return (
    <Tooltip content={label}>
      <NavLink
        to={to}
        end={to === '/'}
        aria-label={label}
        className={({ isActive }) =>
          cn(
            'flex items-center justify-center rounded-lg p-2 transition-colors',
            isActive ? 'bg-sidebar-item-active text-sidebar-text-active' : 'text-sidebar-text hover:bg-sidebar-item-hover hover:text-sidebar-text-active',
          )
        }
      >
        <Icon className={cn('h-4 w-4', iconClassName)} aria-hidden />
      </NavLink>
    </Tooltip>
  )
}

/**
 * Bottom sidebar icons.
 *
 * When an update is ready to install, we deliberately DO NOT add an extra icon.
 * Instead, we pulse the "About" icon in green and update its tooltip to "New version downloaded".
 * The About page is the natural place for updates where users can read release notes and click "Install now".
 * During background downloading, we deliberately keep the UI unchanged (silent background downloads are intentional).
 * Using green here does not violate the ModeIndicator neutrality rule because verified package readiness is a proven fact.
 */
function FooterIcons() {
  const t = useT()
  const update = useUpdateState()
  const updateReady = hasPendingUpdate(update)
  const nextVersion = update.pending?.version || ''

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-1">
        {footerNavItems.map(({ to, icon, labelKey }) => {
          const highlight = updateReady && to === '/about'
          return (
            <IconOnlyNavItem
              key={to}
              to={to}
              icon={icon}
              label={highlight ? t('update.aboutTooltip', { version: nextVersion }) : t(labelKey)}
              iconClassName={highlight ? 'text-success animate-pulse' : undefined}
            />
          )
        })}
      </div>
      <ModeIndicator />
    </div>
  )
}

/**
 * Server mode connection state indicator.
 * Only the server mode has an active, continuous heartbeat connection (30s interval),
 * allowing it to report real-time status (connected/connecting/disconnected/error).
 */
const statusConfig = {
  connected: { icon: Wifi, color: 'text-success', labelKey: 'connection.connected' },
  connecting: { icon: Wifi, color: 'text-warning animate-pulse', labelKey: 'connection.connecting' },
  disconnected: { icon: WifiOff, color: 'text-muted-foreground', labelKey: 'connection.disconnected' },
  error: { icon: WifiOff, color: 'text-destructive', labelKey: 'connection.error' },
} as const satisfies Record<string, { icon: typeof Wifi; color: string; labelKey: TranslationKey }>

/**
 * Engine status indicator at the bottom-left of the sidebar.
 *
 * Local and Cloud API modes use neutral monochrome styling without falsely indicating a "green/ready" state,
 * because configuration completeness alone does not guarantee API key validity or model loading capability.
 * Only confirmed blocking errors transition to warning colors.
 */
function ModeIndicator() {
  const t = useT()
  const status = useConnectionStatus()
  const { mode, detail, ready, blockedReason } = useSyncExternalStore(subscribeModeStatus, getModeStatus)

  useEffect(() => { void refreshModeStatus() }, [])

  if (mode === 'server') {
    const { icon: StatusIcon, color, labelKey } = statusConfig[status]
    return (
      <Tooltip content={t('mode.tooltipDetail', { mode: t('mode.server'), detail: t(labelKey) })}>
        <div className="flex items-center justify-center rounded-lg p-2">
          <StatusIcon className={cn('h-4 w-4', color)} />
        </div>
      </Tooltip>
    )
  }

  const Icon = mode === 'local' ? Cpu : Cloud
  const title = mode === 'local' ? t('mode.local') : t('mode.cloudApi')
  const notReady = ready === false
  const tip = notReady
    ? t('mode.tooltipNotReady', { mode: title, reason: blockedReason || t('mode.notReadyFallback') })
    : detail ? t('mode.tooltipDetail', { mode: title, detail }) : title

  return (
    <Tooltip content={tip}>
      <div className="flex items-center justify-center rounded-lg p-2">
        <Icon className={cn('h-4 w-4', notReady ? 'text-warning' : 'text-sidebar-text')} />
      </div>
    </Tooltip>
  )
}

export default function Sidebar() {
  const t = useT()
  return (
    <nav className="flex w-52 flex-col border-r border-sidebar-border bg-sidebar py-3">
      <div className="custom-scrollbar flex-1 space-y-4 overflow-y-auto px-2">
        {/* Workspace */}
        <div className="space-y-1">
          <div className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            {t('nav.section.workspace')}
          </div>
          {workspaceNavItems.map(({ to, icon, labelKey }) => (
            <NavItem key={to} to={to} icon={icon} label={t(labelKey)} />
          ))}
        </div>

        {/* Voice & AI */}
        <div className="space-y-1">
          <div className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            {t('nav.section.ai')}
          </div>
          {aiNavItems.map(({ to, icon, labelKey }) => (
            <NavItem key={to} to={to} icon={icon} label={t(labelKey)} />
          ))}
        </div>

        {/* System Settings */}
        <div className="space-y-1">
          <div className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            {t('nav.section.settings')}
          </div>
          {systemNavItems.map(({ to, icon, labelKey }) => (
            <NavItem key={to} to={to} icon={icon} label={t(labelKey)} />
          ))}
        </div>
      </div>

      <div className="border-t border-sidebar-border px-3 pt-3">
        <FooterIcons />
      </div>
    </nav>
  )
}
