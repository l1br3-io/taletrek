import { useCallback, useEffect, useState } from 'react'
import { type DownloadState, VoicePicker } from '../components/VoicePicker'
import { type Theme, useSetting } from '../hooks/useSetting'
import { ttsClient } from '../lib/tts/client'
import { CURATED_VOICES } from '../lib/tts/voices'
import type { VoiceId } from '../types'

const THEMES: { value: Theme; label: string; hint: string }[] = [
  { value: 'dark', label: 'Dark', hint: 'Default — low light' },
  { value: 'sepia', label: 'Sepia', hint: 'Warm, paper-like' },
]

export function Settings() {
  const [theme, setTheme] = useSetting('theme')
  const [fontScale, setFontScale] = useSetting('fontScale')
  const [voiceId, setVoiceId] = useSetting('voiceId')
  const [playbackRate, setPlaybackRate] = useSetting('playbackRate')

  const [storedIds, setStoredIds] = useState<ReadonlySet<string>>(new Set())
  const [downloading, setDownloading] = useState<DownloadState | null>(null)

  // Refresh which voice models are already in OPFS.
  const refreshStored = useCallback(async () => {
    const results = await Promise.all(CURATED_VOICES.map((v) => ttsClient.isStored(v.id)))
    setStoredIds(new Set(CURATED_VOICES.filter((_, i) => results[i]).map((v) => v.id)))
  }, [])

  useEffect(() => {
    void refreshStored()
  }, [refreshStored])

  const handleDownload = async (id: VoiceId) => {
    setDownloading({ id, progress: 0 })
    try {
      await ttsClient.download(id, (fraction) => setDownloading({ id, progress: fraction }))
      setStoredIds((prev) => new Set(prev).add(id))
    } finally {
      setDownloading(null)
    }
  }

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Theme</h2>
        <div className="grid grid-cols-2 gap-3">
          {THEMES.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => setTheme(t.value)}
              aria-pressed={theme === t.value}
              className={[
                'rounded-lg border p-4 text-left transition-colors',
                theme === t.value ? 'border-accent bg-elevated' : 'border-line hover:border-muted',
              ].join(' ')}
            >
              <div className="font-medium">{t.label}</div>
              <div className="text-xs text-muted">{t.hint}</div>
            </button>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          Reader text size
          <span className="ml-2 text-fg">×{fontScale.toFixed(2)}</span>
        </h2>
        <input
          type="range"
          min={0.75}
          max={1.75}
          step={0.05}
          value={fontScale}
          onChange={(e) => setFontScale(Number(e.target.value))}
          className="w-full accent-accent"
          aria-label="Reader text size"
        />
        <p className="tt-reader-text rounded-md bg-surface p-3 text-fg">
          The first sentence of your book will appear like this.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Voice</h2>
        <VoicePicker
          voices={CURATED_VOICES}
          activeVoiceId={voiceId}
          storedIds={storedIds}
          downloading={downloading}
          onSelect={setVoiceId}
          onDownload={handleDownload}
        />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
          Playback speed
          <span className="ml-2 text-fg">×{playbackRate.toFixed(2)}</span>
        </h2>
        <input
          type="range"
          min={0.5}
          max={2}
          step={0.25}
          value={playbackRate}
          onChange={(e) => setPlaybackRate(Number(e.target.value))}
          className="w-full accent-accent"
          aria-label="Playback speed"
        />
      </section>

      <p className="text-sm text-muted">
        Settings are stored on this device (IndexedDB) and survive a reload or restart. Voice models
        download once and are cached offline. Nothing leaves your phone.
      </p>
    </div>
  )
}
