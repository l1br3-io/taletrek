import { useCallback, useEffect, useState } from 'react'
import { type DownloadState, VoicePicker } from '../components/VoicePicker'
import { type Theme, useSetting } from '../hooks/useSetting'
import type { CleaningFilters, PronunciationEntry } from '../lib/clean/types'
import { ttsClient } from '../lib/tts/client'
import { CURATED_VOICES } from '../lib/tts/voices'
import type { VoiceId } from '../types'

const THEMES: { value: Theme; label: string; hint: string }[] = [
  { value: 'dark', label: 'Dark', hint: 'Default — low light' },
  { value: 'sepia', label: 'Sepia', hint: 'Warm, paper-like' },
]

const FILTERS: { key: keyof CleaningFilters; label: string; hint: string }[] = [
  { key: 'urls', label: 'Links & URLs', hint: 'Strip http links and bare URLs' },
  { key: 'images', label: 'Image markers', hint: 'Drop ![alt](url) and [Image: …]' },
  { key: 'footnotes', label: 'Footnote references', hint: 'Remove [n] markers' },
  { key: 'pageNumbers', label: 'Page numbers', hint: 'Drop standalone number paragraphs' },
]

export function Settings() {
  const [theme, setTheme] = useSetting('theme')
  const [fontScale, setFontScale] = useSetting('fontScale')
  const [voiceId, setVoiceId] = useSetting('voiceId')
  const [playbackRate, setPlaybackRate] = useSetting('playbackRate')
  const [cleaning, setCleaning] = useSetting('cleaning')

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

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">
            Text cleaning
          </h2>
          <button
            type="button"
            onClick={() => setCleaning({ ...cleaning, enabled: !cleaning.enabled })}
            aria-pressed={cleaning.enabled}
            aria-label="Toggle text cleaning"
            className={[
              'rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors',
              cleaning.enabled
                ? 'border-accent bg-accent-soft text-accent'
                : 'border-line text-muted',
            ].join(' ')}
          >
            {cleaning.enabled ? 'On' : 'Off'}
          </button>
        </div>
        <p className="text-xs text-muted">
          Strip links, image markers, footnotes, and page numbers so only the story flows.
        </p>
        {cleaning.enabled && (
          <div className="space-y-2">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() =>
                  setCleaning({
                    ...cleaning,
                    filters: { ...cleaning.filters, [f.key]: !cleaning.filters[f.key] },
                  })
                }
                aria-pressed={cleaning.filters[f.key]}
                className={[
                  'flex w-full items-center justify-between rounded-lg border p-3 text-left transition-colors',
                  cleaning.filters[f.key]
                    ? 'border-accent bg-elevated'
                    : 'border-line hover:border-muted',
                ].join(' ')}
              >
                <span>
                  <span className="block font-medium">{f.label}</span>
                  <span className="block text-xs text-muted">{f.hint}</span>
                </span>
                <span className="text-xs font-medium uppercase tracking-wide text-muted">
                  {cleaning.filters[f.key] ? 'On' : 'Off'}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      {cleaning.enabled && (
        <PronunciationEditor
          entries={cleaning.pronunciation}
          onChange={(pronunciation) => setCleaning({ ...cleaning, pronunciation })}
        />
      )}

      <p className="text-sm text-muted">
        Settings are stored on this device (IndexedDB) and survive a reload or restart. Voice models
        download once and are cached offline. Nothing leaves your phone.
      </p>
    </div>
  )
}

function PronunciationEditor({
  entries,
  onChange,
}: {
  entries: PronunciationEntry[]
  onChange: (entries: PronunciationEntry[]) => void
}) {
  const update = (id: string, patch: Partial<PronunciationEntry>) =>
    onChange(entries.map((e) => (e.id === id ? { ...e, ...patch } : e)))
  const remove = (id: string) => onChange(entries.filter((e) => e.id !== id))
  const add = () => onChange([...entries, { id: crypto.randomUUID(), find: '', replace: '' }])

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Pronunciation</h2>
      <p className="text-xs text-muted">
        Replace a word wherever it appears, so the narrator says it the way you want
        (case-insensitive, whole word).
      </p>
      <ul className="space-y-2">
        {entries.map((entry) => (
          <li key={entry.id} className="flex items-center gap-2">
            <input
              type="text"
              value={entry.find}
              onChange={(e) => update(entry.id, { find: e.target.value })}
              placeholder="word"
              aria-label="word to replace"
              className="w-1/3 rounded-md border border-line bg-surface px-3 py-1.5 text-sm"
            />
            <span className="text-muted">→</span>
            <input
              type="text"
              value={entry.replace}
              onChange={(e) => update(entry.id, { replace: e.target.value })}
              placeholder="replacement"
              aria-label="replacement"
              className="flex-1 rounded-md border border-line bg-surface px-3 py-1.5 text-sm"
            />
            <button
              type="button"
              onClick={() => remove(entry.id)}
              aria-label={`remove ${entry.find || 'entry'}`}
              className="rounded-md border border-line px-2.5 py-1.5 text-sm text-muted transition-colors hover:border-red-500 hover:text-red-400"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={add}
        className="rounded-lg border border-dashed border-line px-3 py-2 text-sm text-muted transition-colors hover:border-accent hover:text-accent"
      >
        + Add word
      </button>
    </section>
  )
}
