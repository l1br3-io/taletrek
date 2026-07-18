import { Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  DEFAULT_AI_SETTINGS,
  type SynthMode,
  type Theme,
  useSettings,
} from '../../context/settings'
import type { CleaningFilters } from '../../lib/clean/types'
import { CURATED_VOICES } from '../../lib/tts/voices'
import { AudioCacheIndicator } from './AudioCacheIndicator'
import { AiSettingsSection } from './ai-settings'
import { BackupSection } from './BackupSection'
import { DeleteAllDataDialog } from './DeleteAllDataDialog'
import { InstallPrompt } from './InstallPrompt'
import { OfflineBadge } from './OfflineBadge'
import { PronunciationEditor } from './PronunciationEditor'
import { SettingsGroup } from './SettingsGroup'
import { StorageUsageIndicator } from './StorageUsageIndicator'
import { useSetting } from './useSetting'
import { useSettingsPageState } from './useSettingsPageState'
import { VoicePicker } from './VoicePicker'

const THEMES: { value: Theme; label: string; hint: string }[] = [
  { value: 'dark', label: 'Dark', hint: 'Default — low light' },
  { value: 'sepia', label: 'Sepia', hint: 'Warm, paper-like' },
]

const SYNTH_MODES: { value: SynthMode; label: string; hint: string }[] = [
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
  const [vConsoleEnabled, setVConsoleEnabled] = useSetting('vConsoleEnabled')

  const {
    storedIds,
    downloading,
    clearingCache,
    booksCount,
    deleteDialogOpen,
    deletingAll,
    online,
    cacheStats,
    storageEstimate,
    handleDownload,
    handleRemove,
    handleClearCache,
    handleChangeBudget,
    setDeleteDialogOpen,
    handleDeleteAllResult,
  } = useSettingsPageState({ audioCacheBudgetMb, setAudioCacheBudgetMb })

  const [activeTab, setActiveTab] = useState<'general' | 'ai'>(() => {
    if (typeof window !== 'undefined' && window.location.hash === '#ai') return 'ai'
    return 'general'
  })

  useEffect(() => {
    const onHash = () => setActiveTab(window.location.hash === '#ai' ? 'ai' : 'general')
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const switchTab = (tab: 'general' | 'ai') => {
    setActiveTab(tab)
    window.location.hash = tab === 'ai' ? '#ai' : ''
  }

  const generalContent = (
    <>
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
                  'border p-4 text-left transition-colors',
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
          <p className="tt-reader-text border border-line bg-bg p-3 text-fg">
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
            {SYNTH_MODES.map((m: { value: SynthMode; label: string; hint: string }) => (
              <button
                key={m.value}
                type="button"
                onClick={() => setSynthMode(m.value)}
                aria-pressed={synthMode === m.value}
                className={[
                  'border p-4 text-left transition-colors',
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
            <p className="border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
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
                'border px-3 py-1.5 text-sm font-medium transition-colors',
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
                    'flex w-full items-center justify-between border p-3 text-left transition-colors',
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

      <BackupSection onImported={() => void reloadSettings()} />

      <SettingsGroup title="Debug">
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">
              vConsole overlay
            </h3>
            <button
              type="button"
              onClick={() => setVConsoleEnabled(!vConsoleEnabled)}
              aria-pressed={vConsoleEnabled}
              aria-label="Toggle vConsole overlay"
              className={[
                'border px-3 py-1.5 text-sm font-medium transition-colors',
                vConsoleEnabled
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-line text-muted',
              ].join(' ')}
            >
              {vConsoleEnabled ? 'On' : 'Off'}
            </button>
          </div>
          <p className="text-xs text-muted">
            Show the vConsole mobile-debug panel (console, network, storage) at the bottom of the
            screen. Useful when troubleshooting playback on iOS. Off by default.
          </p>
        </section>
      </SettingsGroup>

      <section className="space-y-3 border border-danger/40 bg-surface p-5">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.15em] text-danger">
          <span aria-hidden>❯</span>
          Danger zone
        </h2>
        <p className="text-xs text-muted">
          Permanently delete every book, voice model, cached audio, and setting from this device.
          There is no undo — export a backup first if you want to keep anything.
        </p>
        <button
          type="button"
          onClick={() => setDeleteDialogOpen(true)}
          className="inline-flex items-center gap-2 border border-danger px-4 py-2 text-sm font-medium text-danger transition-colors hover:bg-danger hover:text-white"
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
    </>
  )

  const TAB = ({ tab }: { tab: 'general' | 'ai' }) => (
    <button
      type="button"
      onClick={() => switchTab(tab)}
      aria-pressed={activeTab === tab}
      className={[
        'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
        activeTab === tab
          ? 'border border-accent bg-accent-soft text-accent'
          : 'border border-line text-muted hover:border-muted',
      ].join(' ')}
    >
      {tab === 'ai' ? 'AI' : 'General'}
    </button>
  )

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="flex items-center gap-2 text-xl font-semibold">
        <span className="text-accent" aria-hidden>
          ❯
        </span>
        Settings
      </h1>

      <div className="flex gap-2">
        <TAB tab="general" />
        <TAB tab="ai" />
      </div>

      {activeTab === 'general' ? generalContent : <AiSettingsSection ai={ai} onChange={setAi} />}
    </div>
  )
}
