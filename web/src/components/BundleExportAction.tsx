/**
 * Per-book "Export bundle" chooser + download orchestration. Mounted by
 * `LibraryPage` when the user picks "Export bundle" from a `BookCard`'s action
 * menu. Presentational in shape: it owns only its own status, and delegates
 * the real work to the bundle lib — {@link exportBookBundle} (IDB → bundle)
 * then {@link writeBookBundle} (bundle → bytes) — then produces a browser
 * download via an object-URL'd anchor (mirrors `BackupSection.exportBackup`).
 *
 * Every typed failure from those layers is mapped here to a user-readable
 * message so no `unknown`/`any` crosses the seam. `NoAudioToExportError`
 * (full mode on a voice-less book) gets a targeted "choose text-only" hint;
 * other {@link BundleError} subclasses surface their own message.
 */

import { Download, FileText, Volume2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { BundleError, NoAudioToExportError } from '../lib/bundle/errors'
import { exportBookBundle } from '../lib/bundle/export'
import { writeBookBundle } from '../lib/bundle/writer'
import type { BookId } from '../types'

interface BundleExportActionProps {
  bookId: BookId
  title: string
  onClose: () => void
}

type Status =
  | { type: 'idle' }
  | { type: 'busy'; full: boolean }
  | { type: 'done'; message: string }
  | { type: 'error'; message: string }

/** Lowercase, hyphen-separate, ASCII-only — safe for a download filename. */
function slugify(s: string): string {
  const out = s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return out || 'book'
}

/** Map a bundle-layer failure onto the message shown to the user. */
function bundleExportMessage(err: unknown): string {
  if (err instanceof NoAudioToExportError)
    return 'This book has no audio to export. Choose text-only instead.'
  if (err instanceof BundleError) return err.message
  return err instanceof Error ? err.message : 'Export failed.'
}

export function BundleExportAction({ bookId, title, onClose }: BundleExportActionProps) {
  const [status, setStatus] = useState<Status>({ type: 'idle' })

  // Escape closes (disabled while busy — a flight in progress shouldn't be
  // orphaned by unmounting mid-await).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && status.type !== 'busy') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, status.type])

  const run = async (full: boolean): Promise<void> => {
    setStatus({ type: 'busy', full })
    try {
      const bundle = await exportBookBundle(bookId, { full })
      const bytes = await writeBookBundle(bundle)
      const blob = new Blob([bytes as BlobPart], { type: 'application/zip' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${slugify(title)}.${full ? 'full' : 'text'}.taletrek`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      setStatus({ type: 'done', message: `Downloaded ${a.download}` })
    } catch (err) {
      setStatus({ type: 'error', message: bundleExportMessage(err) })
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bundle-export-title"
    >
      <div className="w-full max-w-sm space-y-4 rounded-xl border border-line bg-surface p-5">
        <div className="flex items-start justify-between gap-2">
          <h2 id="bundle-export-title" className="text-base font-semibold text-fg">
            Export bundle
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={status.type === 'busy'}
            aria-label="Close export dialog"
            className="text-muted transition-colors hover:text-fg disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="truncate text-sm text-muted" title={title}>
          {title}
        </p>

        {status.type === 'idle' && (
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => void run(false)}
              className="flex w-full items-start gap-3 border border-line p-3 text-left transition-colors hover:border-accent hover:text-accent"
            >
              <FileText className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
              <span className="flex-1">
                <span className="block text-sm font-medium">Text-only</span>
                <span className="block text-xs text-muted">Synth elsewhere</span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => void run(true)}
              className="flex w-full items-start gap-3 border border-line p-3 text-left transition-colors hover:border-accent hover:text-accent"
            >
              <Volume2 className="mt-0.5 h-5 w-5 shrink-0" aria-hidden />
              <span className="flex-1">
                <span className="block text-sm font-medium">Full</span>
                <span className="block text-xs text-muted">Includes audio</span>
              </span>
            </button>
          </div>
        )}

        {status.type === 'busy' && (
          <p className="flex items-center gap-2 text-sm text-muted" role="status">
            <span
              className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
              aria-hidden
            />
            Exporting{status.full ? ' with audio' : ' (text only)'}…
          </p>
        )}

        {status.type === 'done' && (
          <div className="space-y-3">
            <p className="flex items-center gap-2 text-sm text-accent" role="status">
              <Download className="h-4 w-4" aria-hidden />
              {status.message}
            </p>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-accent bg-accent px-3 py-1.5 text-sm font-medium text-bg transition-colors hover:bg-accent-strong"
              >
                Done
              </button>
            </div>
          </div>
        )}

        {status.type === 'error' && (
          <div className="space-y-3">
            <p className="text-sm text-danger" role="alert">
              {status.message}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setStatus({ type: 'idle' })}
                className="rounded-md border border-line px-3 py-1.5 text-sm text-muted transition-colors hover:border-muted"
              >
                Back to choices
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-md border border-line px-3 py-1.5 text-sm text-muted transition-colors hover:border-muted"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
