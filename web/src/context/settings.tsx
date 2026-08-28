import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react'
import type { AiSettings, CloudProvider } from '../lib/ai/types'
import type { CleaningConfig } from '../lib/clean/types'
import { DEFAULT_CLEANING } from '../lib/clean/types'
import { getSetting, setSetting, syncAudioCacheBudget } from '../lib/db'
import type { PlaybackEngineSetting } from '../lib/playback/engines'
import { DEFAULT_VOICE_ID } from '../lib/tts/voices'
import type { VoiceId } from '../types'

export type Theme = 'dark' | 'sepia'

/**
 * Pre-synthesis mode for newly uploaded books.
 * - `'off'` — skip pre-synth entirely; audio is synthesized on demand during reading.
 * - `'standard'` — pre-synth the whole book on upload, bounded by `audioCacheBudgetMb` (LRU eviction).
 * - `'no-limit'` — pre-synth with no eviction (power user; relies only on physical quota).
 */
export type SynthMode = 'off' | 'standard' | 'no-limit'

export interface Settings {
  /** Reading theme. */
  theme: Theme
  /** Reader font scale multiplier. */
  fontScale: number
  /** Active TTS voice (curated catalog id). */
  voiceId: VoiceId
  /** Audio playback speed (0.5–2×); applied via `audio.playbackRate`. */
  playbackRate: number
  /** Text-cleaning pipeline config (M4). */
  cleaning: CleaningConfig
  /** AI post-processing config (M6). Absent on pre-M6 stored settings → falls back to the default (disabled). */
  ai?: AiSettings
  /** Pre-synthesize all paragraphs on upload so the first read is friction-free (default `'standard'`). */
  synthesizeOnUpload: SynthMode
  /** Audio cache budget in megabytes. Drives LRU eviction in the `audioCache` store (only when mode is `'standard'`). */
  audioCacheBudgetMb: number
  /**
   * Mobile playback engine (ADR-0010 / M11). `'auto'` → Web Audio (native) when
   * supported, else FFmpeg. Only affects coarse-pointer devices; desktop is
   * always per-paragraph `<audio>`. Surfaced in Settings → Advanced.
   */
  playbackEngine: PlaybackEngineSetting
  /** Show the vConsole mobile-debug overlay (M9 iOS testing). Off by default. */
  vConsoleEnabled: boolean
}

/** Re-exported for existing importers; lives in `lib/clean` so lib-side
 * egress (the hosted pipeline's bundle write) can share one default. */
export { DEFAULT_CLEANING }

/** M6 default: disabled end-to-end (no UI beyond the toggle, no modals, no downloads). */
export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: false,
  backend: 'cloud',
  cloud: { providers: [], activeProviderId: null },
  transformDefs: [],
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  fontScale: 1,
  voiceId: DEFAULT_VOICE_ID,
  playbackRate: 1,
  cleaning: DEFAULT_CLEANING,
  ai: DEFAULT_AI_SETTINGS,
  synthesizeOnUpload: 'standard',
  audioCacheBudgetMb: 500,
  playbackEngine: 'auto',
  vConsoleEnabled: false,
}

const SETTINGS_KEY = 'app'

/**
 * Migrate AI settings from older shapes to the current cloud-only format.
 *
 * - Pre-M6 / missing: → `DEFAULT_AI_SETTINGS`.
 * - M6 pre-redesign: `cloud: { baseUrl, model }` (single provider) →
 *   `cloud: { providers: [{ id, presetId: 'custom', baseUrl, model }], activeProviderId }`.
 * - Removed local backend: `backend: 'in-browser'` → coerced to `'cloud'`
 *   (the on-device WebLLM engine was removed; see ADR-0005). `enabled` is kept
 *   as-stored — a user who had local-only enabled will see the cloud provider
 *   list (empty until they add one).
 * - Current: already in cloud-only shape → pass through.
 */
function migrateAi(ai: unknown): AiSettings {
  if (!ai || typeof ai !== 'object') return DEFAULT_AI_SETTINGS
  const obj = ai as Partial<AiSettings>
  const cloud = obj.cloud as Record<string, unknown> | undefined

  if (cloud && typeof cloud.baseUrl === 'string' && !Array.isArray(cloud.providers)) {
    const provider: CloudProvider = {
      id: crypto.randomUUID(),
      presetId: 'custom',
      baseUrl: cloud.baseUrl,
      model: typeof cloud.model === 'string' ? cloud.model : '',
    }
    return {
      enabled: obj.enabled ?? false,
      backend: 'cloud',
      cloud: { providers: [provider], activeProviderId: provider.id },
      transformDefs: [],
    }
  }

  // Ensure required fields exist even if stored shape is partial. Coerce the
  // removed `in-browser` backend to `cloud`.
  return {
    enabled: obj.enabled ?? false,
    backend: 'cloud',
    cloud: {
      providers: Array.isArray(obj.cloud?.providers) ? obj.cloud.providers : [],
      activeProviderId: obj.cloud?.activeProviderId ?? null,
      biometricUnlock: obj.cloud?.biometricUnlock === true,
    },
    transformDefs: Array.isArray(obj.transformDefs) ? obj.transformDefs : [],
  }
}

/**
 * Migrate stored settings forward. Currently handles:
 * - `synthesizeOnUpload: boolean → SynthMode` (true → `'standard'`, false/other → `'off'`).
 * - `ai.cloud: { baseUrl, model } → { providers: [...], activeProviderId }` (multi-provider).
 * - `playbackEngine`: coerce unknown/missing values to `'auto'` (M11).
 * Returns the merged + migrated settings. Pure given `stored`.
 */
function migrateSettings(stored: Partial<Settings> | undefined): Settings {
  const merged = { ...DEFAULT_SETTINGS, ...stored }
  if (typeof merged.synthesizeOnUpload === 'boolean') {
    merged.synthesizeOnUpload = merged.synthesizeOnUpload ? 'standard' : 'off'
  } else if (
    merged.synthesizeOnUpload !== 'off' &&
    merged.synthesizeOnUpload !== 'standard' &&
    merged.synthesizeOnUpload !== 'no-limit'
  ) {
    merged.synthesizeOnUpload = 'standard'
  }
  if (
    merged.playbackEngine !== 'auto' &&
    merged.playbackEngine !== 'web-audio' &&
    merged.playbackEngine !== 'ffmpeg'
  ) {
    merged.playbackEngine = 'auto'
  }
  merged.ai = migrateAi(merged.ai)
  return merged
}

/** Resolve the audio-cache budget (bytes) for a synth mode. `Infinity` disables eviction. */
export function synthModeBudgetBytes(mode: SynthMode, mb: number): number {
  return mode === 'no-limit' ? Infinity : mb * 1024 * 1024
}

export type SettingsState = { type: 'loading' } | { type: 'ready'; settings: Settings }

interface SettingsContextValue {
  state: SettingsState
  /** Current settings — defaults while loading, live once ready. */
  settings: Settings
  /** Apply a partial update and persist it to IndexedDB. */
  update: (patch: Partial<Settings>) => Promise<void>
  /** Re-hydrate from IndexedDB. Used after a backup import overwrites settings. */
  reload: () => Promise<void>
}

const SettingsContext = createContext<SettingsContextValue | null>(null)

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SettingsState>({ type: 'loading' })
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)

  // Hydrate from IndexedDB on mount.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const stored = await getSetting<Settings>(SETTINGS_KEY)
      if (cancelled) return
      const merged = migrateSettings(stored)
      setSettings(merged)
      setState({ type: 'ready', settings: merged })
      void syncAudioCacheBudget(
        synthModeBudgetBytes(merged.synthesizeOnUpload, merged.audioCacheBudgetMb),
      )
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Reflect theme + font scale onto the document.
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
    document.documentElement.style.setProperty('--font-scale', String(settings.fontScale))
  }, [settings])

  // Mount/unmount the vConsole debug overlay reactively. The dynamic import
  // keeps vConsole (~50 KB) out of the main bundle unless explicitly enabled.
  const vConsoleRef = useRef<{ destroy?: () => void } | null>(null)
  useEffect(() => {
    if (!settings.vConsoleEnabled) {
      vConsoleRef.current?.destroy?.()
      vConsoleRef.current = null
      return
    }
    if (vConsoleRef.current) return
    let cancelled = false
    void import('vconsole').then(({ default: VConsole }) => {
      if (cancelled) return
      vConsoleRef.current = new VConsole() as { destroy?: () => void }
    })
    return () => {
      cancelled = true
      vConsoleRef.current?.destroy?.()
      vConsoleRef.current = null
    }
  }, [settings.vConsoleEnabled])

  async function update(patch: Partial<Settings>): Promise<void> {
    const next = { ...settings, ...patch }
    setSettings(next)
    const writes: Promise<unknown>[] = [setSetting(SETTINGS_KEY, next)]
    if (
      next.synthesizeOnUpload !== settings.synthesizeOnUpload ||
      next.audioCacheBudgetMb !== settings.audioCacheBudgetMb
    ) {
      writes.push(
        syncAudioCacheBudget(
          synthModeBudgetBytes(next.synthesizeOnUpload, next.audioCacheBudgetMb),
        ),
      )
    }
    await Promise.all(writes)
  }

  async function reload(): Promise<void> {
    const stored = await getSetting<Settings>(SETTINGS_KEY)
    const merged = migrateSettings(stored)
    setSettings(merged)
    setState({ type: 'ready', settings: merged })
    void syncAudioCacheBudget(
      synthModeBudgetBytes(merged.synthesizeOnUpload, merged.audioCacheBudgetMb),
    )
  }

  const value: SettingsContextValue = { state, settings, update, reload }

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettings must be used within <SettingsProvider>')
  return ctx
}
