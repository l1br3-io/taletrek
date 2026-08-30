import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react'
import type { CleaningConfig } from '../lib/clean/types'
import { DEFAULT_CLEANING } from '../lib/clean/types'
import { getSetting, setSetting, syncAudioCacheBudget } from '../lib/db'
import type { PlaybackEngineSetting } from '../lib/playback/engines'
import { DEFAULT_VOICE_ID } from '../lib/tts/voices'
import type { VoiceId } from '../types'

export type Theme = 'dark' | 'sepia'

export interface Settings {
  /** Reading theme. */
  theme: Theme
  /** Reader font scale multiplier. */
  fontScale: number
  /**
   * Default TTS voice id. Post-pivot (ADR-0015) the reader plays each book
   * under its own `book.voiceId`; this remains the stored default for new
   * library entries and the bundle-export fallback.
   */
  voiceId: VoiceId
  /** Audio playback speed (0.5–2×); applied via `audio.playbackRate`. */
  playbackRate: number
  /**
   * Text-cleaning pipeline config. Load-bearing even with synthesis removed:
   * audio-cache lookups are keyed on cleaned + normalized text, so this must
   * reproduce the derivation the stored audio was written under.
   */
  cleaning: CleaningConfig
  /** Audio cache budget in megabytes. Drives LRU eviction in the `audioCache` store. */
  audioCacheBudgetMb: number
  /**
   * Mobile playback engine (ADR-0010 / M11). `'auto'` → Web Audio (native) when
   * supported, else FFmpeg. Only affects coarse-pointer devices; desktop is
   * always per-paragraph `<audio>`. Surfaced in Settings → Advanced.
   */
  playbackEngine: PlaybackEngineSetting
  /** Show the vConsole mobile-debug overlay. Off by default. */
  vConsoleEnabled: boolean
}

/** Re-exported for existing importers; lives in `lib/clean`. */
export { DEFAULT_CLEANING }

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  fontScale: 1,
  voiceId: DEFAULT_VOICE_ID,
  playbackRate: 1,
  cleaning: DEFAULT_CLEANING,
  audioCacheBudgetMb: 500,
  playbackEngine: 'auto',
  vConsoleEnabled: false,
}

const SETTINGS_KEY = 'app'

/**
 * Migrate stored settings forward. Currently handles: coercing an
 * unknown/missing `playbackEngine` to `'auto'`. Returns the merged +
 * migrated settings. Pure given `stored`.
 */
function migrateSettings(stored: Partial<Settings> | undefined): Settings {
  const merged = { ...DEFAULT_SETTINGS, ...stored }
  if (
    merged.playbackEngine !== 'auto' &&
    merged.playbackEngine !== 'web-audio' &&
    merged.playbackEngine !== 'ffmpeg'
  ) {
    merged.playbackEngine = 'auto'
  }
  return merged
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
      void syncAudioCacheBudget(merged.audioCacheBudgetMb * 1024 * 1024)
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
    if (next.audioCacheBudgetMb !== settings.audioCacheBudgetMb) {
      writes.push(syncAudioCacheBudget(next.audioCacheBudgetMb * 1024 * 1024))
    }
    await Promise.all(writes)
  }

  async function reload(): Promise<void> {
    const stored = await getSetting<Settings>(SETTINGS_KEY)
    const merged = migrateSettings(stored)
    setSettings(merged)
    setState({ type: 'ready', settings: merged })
    void syncAudioCacheBudget(merged.audioCacheBudgetMb * 1024 * 1024)
  }

  const value: SettingsContextValue = { state, settings, update, reload }

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettings must be used within <SettingsProvider>')
  return ctx
}
