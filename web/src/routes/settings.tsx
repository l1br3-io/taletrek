import { ArrowRight, Download, Trash2, Upload, X } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { AiSettingsSection } from '../components/AiSettingsSection'
import { AudioCacheIndicator } from '../components/AudioCacheIndicator'
import { DeleteAllDataDialog } from '../components/DeleteAllDataDialog'
import { InstallPrompt } from '../components/InstallPrompt'
import { OfflineBadge } from '../components/OfflineBadge'
import { StorageUsageIndicator } from '../components/StorageUsageIndicator'
import { type DownloadState, VoicePicker } from '../components/VoicePicker'
import { DEFAULT_AI_SETTINGS, type SynthMode, useSettings } from '../context/settings'
import { useAudioCacheStats } from '../hooks/useAudioCacheStats'
import { useOnline } from '../hooks/useOnline'
import { type Theme, useSetting } from '../hooks/useSetting'
import { useStorageEstimate } from '../hooks/useStorageEstimate'
import {
  BackupTooLargeError,
  CorruptBackupError,
  exportBackup,
  type ImportReport,
  importBackup,
} from '../lib/backup'
import type { CleaningFilters, PronunciationEntry } from '../lib/clean/types'
import { clearAllData } from '../lib/clearAllData'
import { clearAudioCache, evictAudioCacheToBudget, getAllBooks } from '../lib/db'
import { ttsClient } from '../lib/tts/client'
import { CURATED_VOICES } from '../lib/tts/voices'
import type { VoiceId } from '../types'

const THEMES: { value: Theme; label: string; hint: string }[] = [
  { value: 'dark', label: 'Dark', hint: 'Default — low light' },
  { value: 'sepia', label: 'Sepia', hint: 'Warm, paper-like' },
]

const SYNTH_MODES: {
  value: SynthMode
  label: string
  hint: string
}[] = [
  { value: 'off', label: 'Off', hint: 'Synthesize on demand while reading' },
  { value: 'standard', label: 'Standard', hint: 'Pre-synth the book, bounded by a cache budget' },
  { value: 'no-limit', label: 'No limit', hint: 'Pre-synth with no eviction (power user)' },
]

const FILTERS: { key: keyof CleaningFilters; label: string; hint: string }[] = [
  { key: 'urls', label: 'Links & URLs', hint: 'Strip http links and bare URLs' },
  { key: 'images', label: 'Image markers', hint: 'Drop ![alt](url) and [Image: …]' },
  { key: 'footnotes', label: 'Footnote references', hint: 'Remove [n] markers' },
  { key: 'pageNumbers', label: 'Page numbers', hint: 'Drop standalone number paragraphs' },
]

export function Settings() {
  const { reload: reloadSettings } = useSettings()
  const [theme, setTheme] = useSetting('theme')
  const [fontScale, setFontScale] = useSetting('fontScale')
  const [voiceId, setVoiceId] = useSetting('voiceId')
  const [playbackRate, setPlaybackRate] = useSetting('playbackRate')
  const [cleaning, setCleaning] = useSetting('cleaning')
  const [aiValue, setAi] = useSetting('ai')
  const ai = aiValue ?? DEFAULT_AI_SETTINGS
  const [synthMode, setSynthMode] = useSetting('synthesizeOnUpload')
  const [audioCacheBudgetMb, setAudioCacheBudgetMb] = useSetting('audioCacheBudgetMb')

  const [storedIds, setStoredIds] = useState<ReadonlySet<string>>(new Set())
  const [downloading, setDownloading] = useState<DownloadState | null>(null)
  const [clearingCache, setClearingCache] = useState(false)
  const [booksCount, setBooksCount] = useState(0)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deletingAll, setDeletingAll] = useState(false)
  const online = useOnline()
  const cacheStats = useAudioCacheStats()
  const storageEstimate = useStorageEstimate()

  // Refresh which voice models are already in OPFS.
  const refreshStored = useCallback(async () => {
    const results = await Promise.all(CURATED_VOICES.map((v) => ttsClient.isStored(v.id)))
    setStoredIds(new Set(CURATED_VOICES.filter((_, i) => results[i]).map((v) => v.id)))
  }, [])

  useEffect(() => {
    void refreshStored()
    void getAllBooks().then((books) => setBooksCount(books.length))
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

  const handleRemove = async (id: VoiceId) => {
    await ttsClient.remove(id)
    setStoredIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  const handleClearCache = useCallback(async () => {
    setClearingCache(true)
    try {
      await clearAudioCache()
      await cacheStats.refresh()
      await storageEstimate.refresh()
    } finally {
      setClearingCache(false)
    }
  }, [cacheStats, storageEstimate])

  const handleChangeBudget = useCallback(
    async (mb: number) => {
      const prevMb = audioCacheBudgetMb
      setAudioCacheBudgetMb(mb)
      if (mb < prevMb) {
        await evictAudioCacheToBudget(mb * 1024 * 1024)
        await cacheStats.refresh()
      }
    },
    [audioCacheBudgetMb, setAudioCacheBudgetMb, cacheStats],
  )

  const handleDeleteAllResult = useCallback(async (confirmed: boolean) => {
    if (!confirmed) {
      setDeleteDialogOpen(false)
      return
    }
    setDeletingAll(true)
    try {
      await clearAllData()
    } finally {
      // Reload to a fresh app state — the DB, OPFS, caches, and SW are gone.
      location.reload()
    }
  }, [])

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <InstallPrompt />

      <SettingsGroup title="Reading">
        <section className="space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">Theme</h3>
          <div className="grid grid-cols-2 gap-3">
            {THEMES.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => setTheme(t.value)}
                aria-pressed={theme === t.value}
                className={[
                  'rounded-lg border p-4 text-left transition-colors',
                  theme === t.value
                    ? 'border-accent bg-elevated'
                    : 'border-line hover:border-muted',
                ].join(' ')}
              >
                <div className="font-medium">{t.label}</div>
                <div className="text-xs text-muted">{t.hint}</div>
              </button>
            ))}
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">
            Reader text size
            <span className="ml-2 text-fg">×{fontScale.toFixed(2)}</span>
          </h3>
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
          <p className="tt-reader-text rounded-md bg-bg p-3 text-fg">
            The first sentence of your book will appear like this.
          </p>
        </section>
      </SettingsGroup>

      <SettingsGroup title="Audio">
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">
              Voices &amp; offline
            </h3>
            <OfflineBadge online={online} ready={storedIds.has(voiceId)} />
          </div>
          <p className="text-xs text-muted">
            Download a voice once and it's cached on this device — TaleTrek keeps working with no
            connection. Remove a voice to free up space.
          </p>
          <VoicePicker
            voices={CURATED_VOICES}
            activeVoiceId={voiceId}
            storedIds={storedIds}
            downloading={downloading}
            onSelect={setVoiceId}
            onDownload={handleDownload}
            onRemove={handleRemove}
          />
        </section>

        <section className="space-y-3">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">
            Playback speed
            <span className="ml-2 text-fg">×{playbackRate.toFixed(2)}</span>
          </h3>
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
      </SettingsGroup>

      <SettingsGroup title="Storage">
        <StorageUsageIndicator
          usageBytes={storageEstimate.usage}
          quotaBytes={storageEstimate.quota}
        />
        <p className="text-xs text-muted">
          {booksCount} book{booksCount === 1 ? '' : 's'} · {storedIds.size} voice{' '}
          {storedIds.size === 1 ? 'model' : 'models'} downloaded
          {cacheStats.sizeBytes
            ? ` · ${Math.round(cacheStats.sizeBytes / (1024 * 1024))} MB cached audio`
            : ''}
        </p>

        <section className="space-y-3">
          <h3 className="text-sm font-medium text-fg">Pre-synthesize on upload</h3>
          <p className="text-xs text-muted">
            Synthesize the entire audiobook when you upload it, so your first reading session is
            friction-free. You can still start reading before it finishes.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {SYNTH_MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                onClick={() => setSynthMode(m.value)}
                aria-pressed={synthMode === m.value}
                className={[
                  'rounded-lg border p-4 text-left transition-colors',
                  synthMode === m.value
                    ? 'border-accent bg-elevated'
                    : 'border-line hover:border-muted',
                ].join(' ')}
              >
                <div className="font-medium">{m.label}</div>
                <div className="mt-0.5 text-xs text-muted">{m.hint}</div>
              </button>
            ))}
          </div>
          {synthMode === 'no-limit' && (
            <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
              No-limit mode keeps every synthesized paragraph until the browser&apos;s storage quota
              is hit. On low-space devices this can trigger panics that evict half the cache at
              once. Use Standard if you&apos;re unsure.
            </p>
          )}
        </section>

        {synthMode === 'standard' && (
          <section className="space-y-3">
            <h3 className="text-sm font-medium text-fg">
              Audio cache size
              <span className="ml-2 text-muted">
                {audioCacheBudgetMb} MB (~{Math.round((audioCacheBudgetMb * 1024) / 300)}{' '}
                paragraphs)
              </span>
            </h3>
            <input
              type="range"
              min={100}
              max={2000}
              step={50}
              value={audioCacheBudgetMb}
              onChange={(e) => void handleChangeBudget(Number(e.target.value))}
              className="w-full accent-accent"
              aria-label="Audio cache size in megabytes"
            />
            <p className="text-xs text-muted">
              TaleTrek caches the audio it synthesizes so reopening a book picks up instantly where
              you left off. Clearing it frees up space; the audio is re-created on demand.
            </p>
            <AudioCacheIndicator
              sizeBytes={cacheStats.sizeBytes}
              clearing={clearingCache}
              onClear={() => void handleClearCache()}
              budgetBytes={audioCacheBudgetMb * 1024 * 1024}
            />
          </section>
        )}

        {synthMode === 'no-limit' && (
          <section className="space-y-3">
            <AudioCacheIndicator
              sizeBytes={cacheStats.sizeBytes}
              clearing={clearingCache}
              onClear={() => void handleClearCache()}
              budgetBytes={Number.POSITIVE_INFINITY}
            />
          </section>
        )}
      </SettingsGroup>

      <SettingsGroup title="Text cleaning">
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">Filters</h3>
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
      </SettingsGroup>

      <AiSettingsSection ai={ai} onChange={setAi} />

      <BackupSection onImported={() => void reloadSettings()} />

      <section className="space-y-3 rounded-xl border border-danger/40 bg-surface p-5">
        <h2 className="text-base font-semibold text-fg">Danger zone</h2>
        <p className="text-xs text-muted">
          Permanently delete every book, voice model, cached audio, and setting from this device.
          There is no undo — export a backup first if you want to keep anything.
        </p>
        <button
          type="button"
          onClick={() => setDeleteDialogOpen(true)}
          className="inline-flex items-center gap-2 rounded-lg border border-danger px-4 py-2 text-sm font-medium text-danger transition-colors hover:bg-danger hover:text-white"
        >
          <Trash2 className="h-4 w-4" /> Delete all data
        </button>
      </section>

      <DeleteAllDataDialog
        open={deleteDialogOpen}
        busy={deletingAll}
        onResult={(confirmed) => void handleDeleteAllResult(confirmed)}
      />

      <p className="text-sm text-muted">
        Settings are stored on this device (IndexedDB) and survive a reload or restart. Voice models
        download once and are cached offline. Nothing leaves your phone.
      </p>
    </div>
  )
}

function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-5 rounded-xl border border-line bg-surface p-5">
      <h2 className="text-base font-semibold text-fg">{title}</h2>
      {children}
    </section>
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
      <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">Pronunciation</h3>
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
            <ArrowRight className="h-4 w-4 shrink-0 text-muted" />
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
              className="rounded-md border border-line px-2.5 py-1.5 text-sm text-muted transition-colors hover:border-danger hover:text-danger"
            >
              <X className="h-4 w-4" />
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

type BackupStatus =
  | { type: 'idle' }
  | { type: 'busy'; label: string }
  | { type: 'done'; message: string }
  | { type: 'error'; message: string }

function formatReport(report: ImportReport): string {
  const parts = [`${report.booksImported} book${report.booksImported === 1 ? '' : 's'} imported`]
  if (report.booksSkipped > 0) {
    parts.push(`${report.booksSkipped} already present (kept as-is)`)
  }
  if (report.settingsApplied) parts.push('settings restored')
  return `${parts.join(', ')}.`
}

function BackupSection({ onImported }: { onImported: () => void }) {
  const [status, setStatus] = useState<BackupStatus>({ type: 'idle' })

  const handleExport = async () => {
    setStatus({ type: 'busy', label: 'Preparing backup…' })
    try {
      const blob = await exportBackup()
      const date = new Date().toISOString().slice(0, 10)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `taletrek-backup-${date}.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      setStatus({ type: 'done', message: 'Backup downloaded.' })
    } catch (err) {
      setStatus({
        type: 'error',
        message: err instanceof Error ? err.message : 'Export failed.',
      })
    }
  }

  const handleImportFile = async (file: File) => {
    if (
      !window.confirm(
        'Import this backup? New books will be added, books already on this device are kept as-is, and your settings will be overwritten.',
      )
    ) {
      return
    }
    setStatus({ type: 'busy', label: 'Importing…' })
    try {
      const report = await importBackup(file)
      onImported()
      setStatus({ type: 'done', message: formatReport(report) })
    } catch (err) {
      const message =
        err instanceof BackupTooLargeError
          ? err.message
          : err instanceof CorruptBackupError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Import failed.'
      setStatus({ type: 'error', message })
    }
  }

  return (
    <section className="space-y-5 rounded-xl border border-line bg-surface p-5">
      <h2 className="text-base font-semibold text-fg">Backup &amp; transfer</h2>
      <p className="text-xs text-muted">
        Export your library and settings to a file, then import it on another device to pick up
        where you left off. Books already on the target device are kept as-is. Audio cache
        isn&apos;t included — it rebuilds as you read.
      </p>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => void handleExport()}
          disabled={status.type === 'busy'}
          className="inline-flex items-center gap-2 rounded-lg border border-line px-4 py-2 text-sm font-medium transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
        >
          <Download className="h-4 w-4" /> Export backup
        </button>
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-line px-4 py-2 text-sm font-medium transition-colors hover:border-accent hover:text-accent">
          <Upload className="h-4 w-4" /> Import backup
          <input
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = '' // allow re-selecting the same file
              if (file) void handleImportFile(file)
            }}
          />
        </label>
      </div>
      {status.type === 'busy' && (
        <p className="text-xs text-muted" role="status">
          {status.label}
        </p>
      )}
      {status.type === 'done' && (
        <p className="text-xs text-accent" role="status">
          {status.message}
        </p>
      )}
      {status.type === 'error' && (
        <p className="text-xs text-danger" role="alert">
          {status.message}
        </p>
      )}
    </section>
  )
}
