import { createContext, type ReactNode, useContext, useEffect, useState } from 'react'
import type { AiSettings, CloudProvider } from '../lib/ai/types'
import type { CleaningConfig } from '../lib/clean/types'
import { getSetting, setSetting, syncAudioCacheBudget } from '../lib/db'
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
}

export const DEFAULT_CLEANING: CleaningConfig = {
  enabled: true,
  filters: { urls: true, images: true, footnotes: true, pageNumbers: true },
  pronunciation: [],
}

/** M6 default: disabled end-to-end (no UI beyond the toggle, no modals, no downloads). */
export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: false,
  backend: 'in-browser',
  inBrowser: { modelId: 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC' },
  cloud: { providers: [], activeProviderId: null },
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
}

const SETTINGS_KEY = 'app'

/**
 * Migrate AI settings from older shapes to the current multi-provider format.
 *
 * - Pre-M6 / missing: → `DEFAULT_AI_SETTINGS`.
 * - M6 pre-redesign: `cloud: { baseUrl, model }` (single provider) →
 *   `cloud: { providers: [{ id, presetId: 'custom', baseUrl, model }], activeProviderId }`.
 * - Current: already in multi-provider shape → pass through.
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
      backend: obj.backend ?? 'in-browser',
      inBrowser: obj.inBrowser ?? { modelId: 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC' },
      cloud: { providers: [provider], activeProviderId: provider.id },
    }
  }

  // Ensure required fields exist even if stored shape is partial.
  return {
    enabled: obj.enabled ?? false,
    backend: obj.backend ?? 'in-browser',
    inBrowser: obj.inBrowser ?? { modelId: 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC' },
    cloud: {
      providers: Array.isArray(obj.cloud?.providers) ? obj.cloud.providers : [],
      activeProviderId: obj.cloud?.activeProviderId ?? null,
    },
  }
}

/**
 * Migrate stored settings forward. Currently handles:
 * - `synthesizeOnUpload: boolean → SynthMode` (true → `'standard'`, false/other → `'off'`).
 * - `ai.cloud: { baseUrl, model } → { providers: [...], activeProviderId }` (multi-provider).
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
    void getSetting<Settings>(SETTINGS_KEY).then((stored) => {
      if (cancelled) return
      const merged = migrateSettings(stored)
      setSettings(merged)
      setState({ type: 'ready', settings: merged })
      void syncAudioCacheBudget(
        synthModeBudgetBytes(merged.synthesizeOnUpload, merged.audioCacheBudgetMb),
      )
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Reflect theme + font scale onto the document.
  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme
    document.documentElement.style.setProperty('--font-scale', String(settings.fontScale))
  }, [settings])

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
