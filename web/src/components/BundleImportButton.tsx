/**
 * Library-level "Import bundle" control — the SPA's user-facing entry point
 * for a portable `.taletrek` book bundle produced by the desktop synth (or by
 * another device's export). Mirrors the established {@link BackupSection}
 * pattern: a hidden `<input type="file">` wrapped by a styled label, an
 * inline busy/done/error status, and an `onImported` callback the host page
 * uses to refresh its list.
 *
 * Presentational in shape: it owns only its own status, and delegates the
 * real work to the bundle lib — `readBookBundle` (bytes → {@link BookBundle})
 * then `importBookBundle` (bundle → IDB). Every typed failure from those
 * layers is mapped here to a user-readable toast so no `unknown`/`any` leaks
 * across the seam.
 */

import { Upload } from 'lucide-react'
import { useState } from 'react'
import {
  BundleTooLargeError,
  CorruptBundleError,
  UnsupportedBundleKindError,
  UnsupportedSchemaVersionError,
} from '../lib/bundle/errors'
import { importBookBundle } from '../lib/bundle/import'
import { readBookBundle } from '../lib/bundle/reader'

export interface BundleImportReport {
  title: string
  /** `true` when the bundle carried synthesized audio; `false` for text-only. */
  full: boolean
}

interface BundleImportButtonProps {
  /** Fired once after a successful import — the host refreshes its list. */
  onImported: (report: BundleImportReport) => void
  disabled?: boolean
}

type Status =
  | { type: 'idle' }
  | { type: 'busy' }
  | { type: 'done'; message: string }
  | { type: 'error'; message: string }

/** Map a bundle-layer failure onto the toast text shown to the user. */
function bundleErrorMessage(err: unknown): string {
  if (err instanceof CorruptBundleError) return "This file isn't a TaleTrek bundle"
  if (err instanceof UnsupportedBundleKindError) return "Library bundles aren't supported yet"
  if (err instanceof UnsupportedSchemaVersionError)
    return 'This bundle is from a newer TaleTrek — upgrade the app'
  if (err instanceof BundleTooLargeError) return 'Not enough storage to import this bundle.'
  return err instanceof Error ? err.message : 'Import failed.'
}

export function BundleImportButton({ onImported, disabled }: BundleImportButtonProps) {
  const [status, setStatus] = useState<Status>({ type: 'idle' })
  const busy = status.type === 'busy'

  const handleFile = async (file: File): Promise<void> => {
    setStatus({ type: 'busy' })
    try {
      const bundle = await readBookBundle(new Uint8Array(await file.arrayBuffer()))
      await importBookBundle(bundle)
      const report: BundleImportReport = {
        title: bundle.manifest.book.title,
        full: bundle.manifest.audio.present,
      }
      onImported(report)
      setStatus({
        type: 'done',
        message: `Imported “${report.title}”${report.full ? ' (with audio)' : ' (text only)'}`,
      })
    } catch (err) {
      setStatus({ type: 'error', message: bundleErrorMessage(err) })
    }
  }

  const controlDisabled = disabled || busy

  return (
    <div className="space-y-2">
      <label
        className={`inline-flex cursor-pointer items-center gap-2 border border-line px-4 py-2 text-sm font-medium transition-colors hover:border-accent hover:text-accent ${
          controlDisabled ? 'pointer-events-none opacity-50' : ''
        }`}
      >
        <Upload className="h-4 w-4" /> Import bundle
        <input
          type="file"
          accept=".taletrek,.taletrek-lib"
          className="hidden"
          disabled={controlDisabled}
          aria-label="Import a bundle"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = '' // allow re-selecting the same file
            if (file) void handleFile(file)
          }}
        />
      </label>
      {status.type === 'busy' && (
        <p className="text-xs text-muted" role="status">
          Importing…
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
    </div>
  )
}
