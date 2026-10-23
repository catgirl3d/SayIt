import { useEffect, useMemo, useState } from 'react'
import { resolveAsrDispatchProvider } from '@/features/settings/asrProviderCatalog'
import { foldHotwordDelivery, type AsrHotwordCapability } from '@/lib/asrModels'
import { loadAsrHotwordCapabilityMatrix } from '@/services/hotwords/capabilityMatrix'
import { loadHotwordCatalog, type HotwordCatalog } from '@/services/hotwords/settings'
import {
  errorMessage,
  type FileTranscriptionCloudProfile,
  type FileTranscriptionEngine,
} from '@/services/fileTranscription'
import {
  buildHotwordPlan,
  type HotwordCategorySelection,
  type HotwordMode,
} from './hotwordPlan'

// Per-job hotword state for the Files page: the mode and category selection, the shared
// catalog and capability matrix loads with their retries, and the derived start plan. A job
// starts without hotwords; the dictionary is used only after the user turns it on for the file.
export function useFileTranscriptionHotwords({
  engine,
  cloudProfile: selectedCloudProfile,
}: {
  engine: FileTranscriptionEngine
  cloudProfile: FileTranscriptionCloudProfile | null
}) {
  const [hotwordMode, setHotwordMode] = useState<HotwordMode>('none')
  const [hotwordSelection, setHotwordSelection] = useState<HotwordCategorySelection>({
    builtinKeys: [],
    themeIds: [],
  })
  const [hotwordSelectionTouched, setHotwordSelectionTouched] = useState(false)
  const [hotwordCatalog, setHotwordCatalog] = useState<HotwordCatalog | null>(null)
  const [hotwordError, setHotwordError] = useState('')
  const [hotwordReload, setHotwordReload] = useState(0)
  const [hotwordCapabilities, setHotwordCapabilities] = useState<
    Record<string, AsrHotwordCapability> | null
  >(null)
  const [hotwordCapabilitiesError, setHotwordCapabilitiesError] = useState(false)
  const [hotwordCapabilitiesReload, setHotwordCapabilitiesReload] = useState(0)

  // The provider delivery verdict is the Rust capability matrix, so the page warns for exactly
  // the providers that ignore hotwords instead of keeping a second list of its own.
  const providerCapability = hotwordCapabilities !== null && selectedCloudProfile
    ? hotwordCapabilities[resolveAsrDispatchProvider(selectedCloudProfile.provider)]
    : undefined
  const providerDelivery = selectedCloudProfile === null || hotwordCapabilities === null
    ? null
    : foldHotwordDelivery(providerCapability?.delivery ?? 'unknown_provider')
  const providerClientCap = providerCapability?.clientCap ?? null
  // The preview and the start request share this plan, so the words shown are the words sent.
  const hotwordPlan = useMemo(() => buildHotwordPlan({
    mode: hotwordMode,
    selection: hotwordSelection,
    catalog: hotwordCatalog,
    engine,
    provider: selectedCloudProfile?.provider ?? null,
    providerDelivery,
    providerClientCap,
    deepgramKeytermsEnabled: selectedCloudProfile?.deepgramKeytermsEnabled === true,
  }), [engine, hotwordMode, hotwordSelection, hotwordCatalog, selectedCloudProfile, providerDelivery, providerClientCap])

  useEffect(() => {
    let cancelled = false
    setHotwordCatalog(null)
    setHotwordError('')
    void loadHotwordCatalog()
      .then((catalog) => {
        if (!cancelled) setHotwordCatalog(catalog)
      })
      .catch((reason) => {
        if (!cancelled) setHotwordError(errorMessage(reason))
      })
    return () => { cancelled = true }
  }, [hotwordReload])

  useEffect(() => {
    let cancelled = false
    setHotwordCapabilities(null)
    setHotwordCapabilitiesError(false)
    void loadAsrHotwordCapabilityMatrix()
      .then((matrix) => {
        if (cancelled) return
        setHotwordCapabilities(matrix)
      })
      .catch((reason: unknown) => {
        if (cancelled) return
        console.warn('Failed to load ASR hotword capability matrix', reason)
        setHotwordCapabilitiesError(true)
      })
    return () => { cancelled = true }
  }, [hotwordCapabilitiesReload])

  useEffect(() => {
    if (hotwordMode !== 'selected' || hotwordSelectionTouched || !hotwordCatalog) return
    // Start the per-job selection from the active hotwords so it can be trimmed rather than
    // rebuilt from scratch; globally disabled categories remain available to add.
    setHotwordSelection({
      builtinKeys: Object.keys(hotwordCatalog.builtinSetActive).filter(
        (key) => hotwordCatalog.builtinSetActive[key]
          && (hotwordCatalog.builtinSetWords[key]?.length ?? 0) > 0,
      ),
      themeIds: hotwordCatalog.customThemes
        .filter((theme) => hotwordCatalog.customThemeActive[theme.id] && theme.words.length > 0)
        .map((theme) => theme.id),
    })
    setHotwordSelectionTouched(true)
  }, [hotwordMode, hotwordSelectionTouched, hotwordCatalog])

  const changeHotwordSelection = (selection: HotwordCategorySelection) => {
    setHotwordSelection(selection)
    setHotwordSelectionTouched(true)
  }

  const retryHotwordCatalog = () => setHotwordReload((value) => value + 1)
  const retryHotwordCapabilities = () => {
    setHotwordCapabilitiesError(false)
    setHotwordCapabilitiesReload((value) => value + 1)
  }

  // A selected cloud provider must have a capability verdict before a job can start unless the
  // user explicitly disabled hotwords, in which case there is no dictionary to misroute.
  const providerResolved = hotwordMode === 'none'
    || engine !== 'cloud'
    || selectedCloudProfile === null
    || providerDelivery !== null
  const hotwordsReady = providerResolved
    && (!hotwordPlan.applicable || hotwordMode === 'none' || hotwordCatalog !== null)

  return {
    mode: hotwordMode,
    setMode: setHotwordMode,
    selection: hotwordSelection,
    changeSelection: changeHotwordSelection,
    catalog: hotwordCatalog,
    catalogError: hotwordError,
    retryCatalog: retryHotwordCatalog,
    capabilitiesError: hotwordCapabilitiesError,
    retryCapabilities: retryHotwordCapabilities,
    plan: hotwordPlan,
    providerResolved,
    ready: hotwordsReady,
  }
}
