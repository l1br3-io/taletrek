import { createContext, type ReactNode, useContext, useEffect, useState } from 'react'
import { getSetting, setSetting } from '../lib/db'
import { DEFAULT_VOICE_ID } from '../lib/tts/voices'
import type { VoiceId } from '../types'

export type Theme = 'dark' | 'sepia'

export interface Settings {
  /** Reading theme. */
  theme: Theme
  /** Reader font scale multiplier. */
  fontScale: number
  /** Active TTS voice (curated catalog id). */
  voiceId: VoiceId
  /** Audio playback speed (0.5–2×); applied via `audio.playbackRate`. */
  playbackRate: number
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  fontScale: 1,
  voiceId: DEFAULT_VOICE_ID,
  playbackRate: 1,
}

const SETTINGS_KEY = 'app'

export type SettingsState = { type: 'loading' } | { type: 'ready'; settings: Settings }

interface SettingsContextValue {
  state: SettingsState
  /** Current settings — defaults while loading, live once ready. */
  settings: Settings
  /** Apply a partial update and persist it to IndexedDB. */
  update: (patch: Partial<Settings>) => Promise<void>
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
      const merged = { ...DEFAULT_SETTINGS, ...stored }
      setSettings(merged)
      setState({ type: 'ready', settings: merged })
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
    await setSetting(SETTINGS_KEY, next)
  }

  const value: SettingsContextValue = { state, settings, update }

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext)
  if (!ctx) throw new Error('useSettings must be used within <SettingsProvider>')
  return ctx
}
