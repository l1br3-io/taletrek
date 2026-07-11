import type { Voice } from '../lib/tts/types'
import type { VoiceId } from '../types'

export interface DownloadState {
  id: VoiceId
  progress: number // 0–1
}

interface VoicePickerProps {
  voices: readonly Voice[]
  activeVoiceId: VoiceId
  storedIds: ReadonlySet<string>
  downloading: DownloadState | null
  onSelect: (id: VoiceId) => void
  onDownload: (id: VoiceId) => void
  onRemove: (id: VoiceId) => void
}

function formatSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`
}

export function VoicePicker({
  voices,
  activeVoiceId,
  storedIds,
  downloading,
  onSelect,
  onDownload,
  onRemove,
}: VoicePickerProps) {
  return (
    <ul className="space-y-2">
      {voices.map((voice) => {
        const active = voice.id === activeVoiceId
        const stored = storedIds.has(voice.id)
        const isDownloading = downloading?.id === voice.id
        return (
          <li
            key={voice.id}
            className={[
              'flex items-center gap-3 rounded-lg border p-3',
              active ? 'border-accent bg-elevated' : 'border-line',
            ].join(' ')}
          >
            <button
              type="button"
              onClick={() => onSelect(voice.id)}
              aria-pressed={active}
              className="flex-1 text-left"
            >
              <div className="font-medium">
                {voice.name} <span className="text-muted">· {voice.language}</span>
              </div>
              <div className="text-xs text-muted">{formatSize(voice.sizeBytes)}</div>
            </button>
            {stored ? (
              <>
                <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent">
                  downloaded
                </span>
                <button
                  type="button"
                  onClick={() => onRemove(voice.id)}
                  aria-label={`remove ${voice.name}`}
                  className="rounded border border-line px-2 py-1 text-sm transition-colors hover:border-red-500 hover:text-red-400"
                >
                  remove
                </button>
              </>
            ) : isDownloading ? (
              <span className="text-xs text-muted">
                {Math.round((downloading?.progress ?? 0) * 100)}%
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onDownload(voice.id)}
                className="rounded border border-line px-2 py-1 text-sm hover:border-accent"
              >
                download
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}
