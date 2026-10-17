// Config export / import dialogs.
//
// Design constraints (revised twice; recorded so nobody walks back into the old shape):
// 1. In the light theme --primary is close to pure black, so bg-primary/5 and the accent hover
//    are almost the same color. The selected state therefore does not rely on a background or
//    outline; it is expressed by the contrast of "filled checkbox + unselected text dropped to muted".
// 2. Use few outlines. Items of one kind go into a single rounded-xl panel separated by hairline
//    dividers, not one box per row.
// 3. Hierarchy comes from type size, color and whitespace; colors use theme tokens only, never raw
//    color scales.
// 4. The entrance animation reuses animate-fade-in-scale from index.css.

import { useEffect, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  Archive,
  ArrowRightLeft,
  Check,
  Download,
  FileJson,
  KeyRound,
  Loader2,
  SlidersHorizontal,
  Sparkles,
  Tags,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Modal, type ModalProps } from '@/components/ui/modal'
import { type ConfigExportSelection, type ConfigImportPreview } from '@/services/backup'
import { CUSTOM_THEMES_KEY, normalizeCustomThemes, type CustomTheme } from '@/services/hotwords/model'
import { getPromptPresets, getSetting, type PromptPreset } from '@/services/store'
import { getTextReplacements, type TextReplacementRule } from '@/services/textReplacement'
import { useT } from '@/i18n/useT'
import { promptPresetDisplayName } from '@/i18n/displayNames'

/** Backing tile for the header icon, the dialog's visual anchor. */
function IconTile({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'warning' }) {
  const warning = tone === 'warning'
  return (
    <span
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border ${warning ? 'border-warning/25 bg-warning/10 text-warning' : 'border-border/70 bg-muted/60 text-foreground/70'
        }`}
    >
      {children}
    </span>
  )
}

/**
 * Dialog shell: the shared Modal in its sectioned layout (header and footer stay fixed, the middle
 * scrolls) with this feature's panel styling. Esc, backdrop click, focus handling and the dialog
 * stack all come from Modal.
 */
function DialogShell({
  width = 'w-[520px]',
  ...modalProps
}: Omit<ModalProps, 'showCloseButton' | 'panelClassName'> & { width?: string }) {
  return (
    <Modal
      {...modalProps}
      showCloseButton
      panelClassName={`animate-fade-in-scale max-h-[82vh] rounded-2xl shadow-2xl ${width}`}
    />
  )
}

/** Segmented switch: a muted track with a card-colored thumb, cleaner than a group of outlined buttons. */
function SegmentedTabs<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (next: T) => void
}) {
  return (
    <div className="flex gap-0.5 rounded-lg bg-muted/70 p-0.5">
      {options.map((option) => {
        const active = value === option.value
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={`flex-1 rounded-[7px] px-3 py-1.5 text-xs transition-colors ${active
              ? 'bg-card font-medium text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
              }`}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/** Item panel: a group of items of one kind shares a single panel with hairline dividers. */
function Panel({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border/70 divide-y divide-border/60">{children}</div>
  )
}

/** Subheading: the group name plus a light text button on the right. */
function GroupLabel({
  icon,
  title,
  action,
}: {
  icon: ReactNode
  title: string
  action?: ReactNode
}) {
  return (
    <div className="mb-1.5 flex items-center justify-between gap-3 px-0.5">
      <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        {icon}
        <span className="truncate text-xs font-medium">{title}</span>
      </div>
      {action}
    </div>
  )
}

function TextButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 rounded text-xs text-muted-foreground/70 transition-colors hover:text-foreground"
    >
      {children}
    </button>
  )
}

/** Read-only info row, used in the "Full configuration" list. */
function InfoRow({
  icon,
  title,
  meta,
  badge,
}: {
  icon: ReactNode
  title: string
  meta?: string
  badge?: ReactNode
}) {
  return (
    <div className="flex items-center gap-3 px-3.5 py-2.5">
      <span className="shrink-0 text-muted-foreground/60">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
      {badge}
      {meta && <span className="shrink-0 text-xs tabular-nums text-muted-foreground/80">{meta}</span>}
    </div>
  )
}

/** Checkbox row: selected is a filled box with normal text color; unselected drops the whole row to muted. */
function ChoiceRow({
  checked,
  onChange,
  title,
  meta,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  title: string
  meta?: string
}) {
  return (
    <label className="group flex cursor-pointer items-center gap-3 px-3.5 py-2.5 transition-colors hover:bg-muted/40">
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span
        aria-hidden="true"
        className={`flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-[5px] border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-card ${checked
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-muted-foreground/30 group-hover:border-muted-foreground/60'
          }`}
      >
        {checked && <Check className="h-3 w-3" strokeWidth={3} />}
      </span>
      <span
        className={`min-w-0 flex-1 truncate text-sm transition-colors ${checked ? 'text-foreground' : 'text-muted-foreground'
          }`}
      >
        {title}
      </span>
      {meta && <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70">{meta}</span>}
    </label>
  )
}

function EmptyRow({ children }: { children: ReactNode }) {
  return <p className="px-3.5 py-3 text-xs text-muted-foreground/70">{children}</p>
}

/** Warning strip, shown only when the user really needs a reminder. */
function WarningNote({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-warning/25 bg-warning/[0.07] px-3.5 py-2.5 text-xs leading-relaxed text-foreground/75">
      <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-warning" />
      <span className="min-w-0">{children}</span>
    </div>
  )
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-md bg-warning/10 px-1.5 py-0.5 text-[11px] font-medium text-warning">
      {children}
    </span>
  )
}

type ExportMode = 'full' | 'selected'

function sectionLabel(kind: string, t: ReturnType<typeof useT>): string {
  switch (kind) {
    case 'fullConfig': return t('configTransfer.fullConfig')
    case 'appSettings': return t('configTransfer.appSettings')
    case 'hotwords': return t('configTransfer.hotwordGroups')
    case 'textReplacements': return t('configTransfer.textReplacements')
    case 'promptPresets': return t('configTransfer.promptPresets')
    case 'appPromptRules': return t('configTransfer.appPromptRules')
    default: return kind
  }
}

export function ConfigExportDialog({
  onClose,
  onExport,
}: {
  onClose: () => void
  onExport: (selection: ConfigExportSelection) => void
}) {
  const t = useT()
  const [mode, setMode] = useState<ExportMode>('full')
  const [themes, setThemes] = useState<CustomTheme[]>([])
  const [replacements, setReplacements] = useState<TextReplacementRule[]>([])
  const [presets, setPresets] = useState<PromptPreset[]>([])
  const [selectedThemeIds, setSelectedThemeIds] = useState<string[]>([])
  const [includeReplacements, setIncludeReplacements] = useState(true)
  const [selectedPresetIds, setSelectedPresetIds] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    let active = true
    void Promise.all([getSetting<unknown>(CUSTOM_THEMES_KEY, []), getTextReplacements(), getPromptPresets()])
      .then(([rawThemes, loadedReplacements, loadedPresets]) => {
        if (!active) return
        const customThemes = normalizeCustomThemes(rawThemes)
        const customPresets = loadedPresets.filter((preset) => !preset.builtin)
        setThemes(customThemes)
        setReplacements(loadedReplacements)
        setIncludeReplacements(loadedReplacements.length > 0)
        setPresets(customPresets)
        setSelectedThemeIds(customThemes.map((theme) => theme.id))
        setSelectedPresetIds(customPresets.map((preset) => preset.id))
      })
      .catch((error) => {
        if (active) setLoadError(t('configTransfer.readFailed', { message: String(error) }))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const toggleId = (id: string, checked: boolean, values: string[], setValues: (next: string[]) => void) => {
    setValues(checked ? [...values, id] : values.filter((value) => value !== id))
  }

  const replacementChoiceCount = replacements.length > 0 ? 1 : 0
  const selectedCount =
    selectedThemeIds.length + (includeReplacements && replacementChoiceCount > 0 ? 1 : 0) + selectedPresetIds.length
  const hasSelectable = themes.length + replacementChoiceCount + presets.length > 0

  const exportSelected = () => {
    onExport({
      mode: 'selected',
      hotwordGroupIds: selectedThemeIds,
      includeTextReplacements: includeReplacements,
      textReplacements: includeReplacements ? replacements : undefined,
      promptPresetIds: selectedPresetIds,
    })
  }

  const isFull = mode === 'full'

  const footer = (
    <>
      <p className="min-w-0 truncate text-xs text-muted-foreground">
        {loading
          ? t('configTransfer.reading')
          : isFull
            ? t('configTransfer.singleJson')
            : selectedCount > 0
              ? t('configTransfer.selectedCount', { count: selectedCount })
              : t('configTransfer.nothingSelected')}
      </p>
      <div className="flex shrink-0 gap-2">
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t('configTransfer.cancel')}
        </Button>
        <Button
          size="sm"
          className="gap-1.5"
          onClick={isFull ? () => onExport({ mode: 'full' }) : exportSelected}
          disabled={!isFull && (loading || Boolean(loadError) || selectedCount === 0)}
        >
          <Download className="h-3.5 w-3.5" />
          {t('configTransfer.export')}
        </Button>
      </div>
    </>
  )

  return (
    <DialogShell
      icon={
        <IconTile>
          <Archive className="h-4 w-4" />
        </IconTile>
      }
      title={t('configTransfer.exportTitle')}
      description={t('configTransfer.exportDesc')}
      footer={footer}
      onClose={onClose}
    >
      <SegmentedTabs
        value={mode}
        onChange={setMode}
        options={[
          { value: 'full', label: t('configTransfer.fullConfig') },
          { value: 'selected', label: t('configTransfer.selectedConfig') },
        ]}
      />

      {loading ? (
        <div className="mt-4 flex items-center justify-center gap-2 py-12 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('configTransfer.reading')}
        </div>
      ) : loadError ? (
        <div className="mt-4 rounded-xl border border-destructive/25 bg-destructive/[0.07] px-3.5 py-2.5 text-xs text-destructive">
          {loadError}
        </div>
      ) : isFull ? (
        <div className="mt-4 space-y-3">
          <Panel>
            <InfoRow
              icon={<SlidersHorizontal className="h-4 w-4" />}
              title={t('configTransfer.appSettings')}
              meta={t('configTransfer.appSettingsMeta')}
            />
            <InfoRow icon={<KeyRound className="h-4 w-4" />} title={t('configTransfer.aiProviders')} badge={<Badge>{t('configTransfer.containsKeys')}</Badge>} />
            <InfoRow
              icon={<Tags className="h-4 w-4" />}
              title={t('configTransfer.hotwordGroups')}
              meta={themes.length > 0 ? t('configTransfer.groupCount', { count: themes.length }) : t('configTransfer.none')}
            />
            <InfoRow
              icon={<ArrowRightLeft className="h-4 w-4" />}
              title={t('configTransfer.textReplacements')}
              meta={replacements.length > 0 ? t('configTransfer.ruleCount', { count: replacements.length }) : t('configTransfer.none')}
            />
            <InfoRow
              icon={<Sparkles className="h-4 w-4" />}
              title={t('configTransfer.promptPresets')}
              meta={presets.length > 0 ? t('configTransfer.presetCount', { count: presets.length }) : t('configTransfer.none')}
            />
          </Panel>
          <WarningNote>{t('configTransfer.keyWarning')}</WarningNote>
          <p className="px-0.5 text-xs leading-relaxed text-muted-foreground/70">
            {t('configTransfer.noHistory')}
          </p>
        </div>
      ) : (
        <div className="mt-4 space-y-4">
          <section>
            <GroupLabel
              icon={<Tags className="h-3.5 w-3.5" />}
              title={t('configTransfer.hotwordGroups')}
              action={
                themes.length > 1 && (
                  <TextButton
                    onClick={() =>
                      setSelectedThemeIds(
                        selectedThemeIds.length === themes.length ? [] : themes.map((theme) => theme.id),
                      )
                    }
                  >
                    {selectedThemeIds.length === themes.length ? t('configTransfer.clear') : t('configTransfer.selectAll')}
                  </TextButton>
                )
              }
            />
            <Panel>
              {themes.length > 0 ? (
                themes.map((theme) => (
                  <ChoiceRow
                    key={theme.id}
                    checked={selectedThemeIds.includes(theme.id)}
                    onChange={(checked) => toggleId(theme.id, checked, selectedThemeIds, setSelectedThemeIds)}
                    title={theme.name}
                    meta={t('configTransfer.wordCount', { count: theme.words.length })}
                  />
                ))
              ) : (
                <EmptyRow>{t('configTransfer.noHotwords')}</EmptyRow>
              )}
            </Panel>
          </section>

          <section>
            <GroupLabel icon={<ArrowRightLeft className="h-3.5 w-3.5" />} title={t('configTransfer.textReplacements')} />
            <Panel>
              {replacements.length > 0 ? (
                <ChoiceRow
                  checked={includeReplacements}
                  onChange={setIncludeReplacements}
                  title={t('configTransfer.allReplacementRules')}
                  meta={t('configTransfer.ruleCount', { count: replacements.length })}
                />
              ) : (
                <EmptyRow>{t('configTransfer.noReplacements')}</EmptyRow>
              )}
            </Panel>
          </section>

          <section>
            <GroupLabel
              icon={<Sparkles className="h-3.5 w-3.5" />}
              title={t('configTransfer.promptPresets')}
              action={
                presets.length > 1 && (
                  <TextButton
                    onClick={() =>
                      setSelectedPresetIds(
                        selectedPresetIds.length === presets.length ? [] : presets.map((preset) => preset.id),
                      )
                    }
                  >
                    {selectedPresetIds.length === presets.length ? t('configTransfer.clear') : t('configTransfer.selectAll')}
                  </TextButton>
                )
              }
            />
            <Panel>
              {presets.length > 0 ? (
                presets.map((preset) => (
                  <ChoiceRow
                    key={preset.id}
                    checked={selectedPresetIds.includes(preset.id)}
                    onChange={(checked) => toggleId(preset.id, checked, selectedPresetIds, setSelectedPresetIds)}
                    title={promptPresetDisplayName(preset)}
                  />
                ))
              ) : (
                <EmptyRow>{t('configTransfer.noPresets')}</EmptyRow>
              )}
            </Panel>
          </section>

          <p className="px-0.5 text-xs leading-relaxed text-muted-foreground/70">
            {hasSelectable
              ? t('configTransfer.safeToShare')
              : t('configTransfer.nothingToShare')}
          </p>
        </div>
      )}
    </DialogShell>
  )
}

export function ConfigImportDialog({
  filePath,
  preview,
  onClose,
  onConfirm,
}: {
  filePath: string
  preview: ConfigImportPreview
  onClose: () => void
  onConfirm: () => void
}) {
  const t = useT()
  const isSelected = preview.scope === 'selected'
  const fileName = filePath.split(/[\\/]/).pop() || filePath

  const footer = (
    <>
      <p className="min-w-0 truncate text-xs text-muted-foreground">{t('configTransfer.restartAfterImport')}</p>
      <div className="flex shrink-0 gap-2">
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t('configTransfer.cancel')}
        </Button>
        <Button size="sm" variant={isSelected ? 'default' : 'destructive'} onClick={onConfirm}>
          {isSelected ? t('configTransfer.confirmImport') : t('configTransfer.overwriteImport')}
        </Button>
      </div>
    </>
  )

  return (
    <DialogShell
      icon={
        <IconTile tone={isSelected ? 'default' : 'warning'}>
          {isSelected ? <Archive className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
        </IconTile>
      }
      title={t('configTransfer.importTitle')}
      description={
        isSelected
          ? t('configTransfer.selectedImportDesc')
          : t('configTransfer.fullImportDesc')
      }
      footer={footer}
      onClose={onClose}
      width="w-[500px]"
    >
      <div className="flex items-center gap-2 rounded-xl border border-border/70 bg-muted/30 px-3.5 py-2.5">
        <FileJson className="h-4 w-4 shrink-0 text-muted-foreground/60" />
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={filePath}>
          {fileName}
        </span>
      </div>

      <div className="mt-3 space-y-3">
        <Panel>
          {preview.sections.map((section) => (
            <div key={section.kind} className="flex items-center gap-3 px-3.5 py-2.5">
              <span className="min-w-0 flex-1 truncate text-sm">{sectionLabel(section.kind, t)}</span>
              {isSelected ? (
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground/80">
                  {t('configTransfer.changeSummary', {
                    added: section.added,
                    updated: section.updated,
                    skipped: section.skipped,
                  })}
                </span>
              ) : (
                <span className="shrink-0 text-xs text-muted-foreground/80">{t('configTransfer.willOverwrite')}</span>
              )}
            </div>
          ))}
        </Panel>

        {preview.warnings.length > 0 && (
          <WarningNote>
            {preview.warnings.map((warning, index) => (
              <span key={`${warning.code}-${index}`} className="block">
                {warning.code === 'hotwordLimit'
                  ? t('configTransfer.hotwordLimitWarning', {
                    current: warning.current ?? 0,
                    limit: warning.limit ?? 0,
                  })
                  : warning.code === 'fullOverwrite'
                    ? t('configTransfer.fullOverwriteWarning')
                    : t('configTransfer.unknownWarning', { code: warning.code })}
              </span>
            ))}
          </WarningNote>
        )}
      </div>
    </DialogShell>
  )
}

/** Overwrite confirmation for the full-data import. Shares the shell with the config import so one panel does not show two dialog styles. */
export function FullImportConfirmDialog({
  filePath,
  onClose,
  onConfirm,
}: {
  filePath: string
  onClose: () => void
  onConfirm: () => void
}) {
  const t = useT()
  const fileName = filePath.split(/[\\/]/).pop() || filePath

  return (
    <DialogShell
      icon={
        <IconTile tone="warning">
          <AlertTriangle className="h-4 w-4" />
        </IconTile>
      }
      title={t('configTransfer.fullDataTitle')}
      description={t('configTransfer.fullDataDesc')}
      width="w-[460px]"
      onClose={onClose}
      footer={
        <>
          <p className="min-w-0 truncate text-xs text-muted-foreground">{t('configTransfer.restartAfterImport')}</p>
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="ghost" onClick={onClose}>
              {t('configTransfer.cancel')}
            </Button>
            <Button size="sm" variant="destructive" onClick={onConfirm}>
              {t('configTransfer.overwriteImport')}
            </Button>
          </div>
        </>
      }
    >
      <div className="flex items-center gap-2 rounded-xl border border-border/70 bg-muted/30 px-3.5 py-2.5">
        <Archive className="h-4 w-4 shrink-0 text-muted-foreground/60" />
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={filePath}>
          {fileName}
        </span>
      </div>
      <div className="mt-3">
        <WarningNote>{t('configTransfer.rollbackHint')}</WarningNote>
      </div>
    </DialogShell>
  )
}

/** Import-success notice; the app restarts automatically shortly after. The centered-icon style matches the auto-update dialog. */
export function ImportDoneDialog() {
  const t = useT()
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 p-6 backdrop-blur-sm">
      <div className="animate-fade-in-scale w-[320px] rounded-2xl border border-border bg-card p-6 text-center shadow-2xl">
        <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-success/10">
          <Check className="h-5 w-5 text-success" strokeWidth={2.5} />
        </span>
        <h3 className="mt-3 text-[15px] font-semibold">{t('configTransfer.importDone')}</h3>
        <p className="mt-1.5 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('configTransfer.restarting')}
        </p>
      </div>
    </div>
  )
}
