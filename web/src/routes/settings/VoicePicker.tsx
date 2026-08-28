import { Check, Download, Trash2 } from 'lucide-react'
import type { Voice } from '../../lib/tts/types'
import type { VoiceId } from '../../types'

export interface DownloadState {
  id: VoiceId
  progress: number // 0–1
}

interface VoicePickerProps {
  voices: readonly Voice[]
  activeVoiceId: VoiceId
  onSelect: (id: VoiceId) => void
  /**
   * Local-mode on-device storage controls. Omitted in hosted mode (T16) —
   * voices live on the server, so the picker renders select-only rows.
   */
  storedIds?: ReadonlySet<string>
  downloading?: DownloadState | null
  onDownload?: (id: VoiceId) => void
  onRemove?: (id: VoiceId) => void
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
  const managed = onDownload !== undefined || onRemove !== undefined
  return (
    <ul className="space-y-2">
      {voices.map((voice) => {
        const active = voice.id === activeVoiceId
        const stored = managed && storedIds?.has(voice.id)
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
                <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent">
                  <Check className="h-3 w-3" /> downloaded
                </span>
                {onRemove && (
                  <button
                    type="button"
                    onClick={() => onRemove(voice.id)}
                    aria-label={`remove ${voice.name}`}
                    className="inline-flex items-center gap-1 rounded border border-line px-2 py-1 text-sm transition-colors hover:border-danger hover:text-danger"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> remove
                  </button>
                )}
              </>
            ) : isDownloading ? (
              <span className="text-xs text-muted">
                {Math.round((downloading?.progress ?? 0) * 100)}%
              </span>
            ) : onDownload ? (
              <button
                type="button"
                onClick={() => onDownload(voice.id)}
                className="inline-flex items-center gap-1 rounded border border-line px-2 py-1 text-sm hover:border-accent"
              >
                <Download className="h-3.5 w-3.5" /> download
              </button>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
