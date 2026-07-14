import { AlertTriangle, Download } from 'lucide-react'
import { useEffect } from 'react'

interface KeyExportConfirmDialogProps {
  open: boolean
  /** Provider label, for the dialog title / filename context. */
  label: string
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Confirmation shown before exporting a provider whose API key is loaded in
 * memory. The exported `.json` file includes the key in plaintext, so the file
 * is a secret — it lives in the user's downloads folder and may be synced to
 * cloud storage. This dialog makes that explicit before the download starts.
 *
 * Consistent with ADR-0004: TaleTrek itself still never persists the key — this
 * is an explicit, user-initiated write to a file they own.
 */
export function KeyExportConfirmDialog({
  open,
  label,
  onConfirm,
  onCancel,
}: KeyExportConfirmDialogProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={`Export ${label} with API key`}
    >
      <div className="w-full max-w-md space-y-4 rounded-xl border border-warning/50 bg-surface p-5 shadow-2xl">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-warning" />
          <h2 className="text-base font-semibold text-fg">Export includes your API key</h2>
        </div>
        <p className="text-sm text-muted">
          The downloaded <code className="font-mono text-fg">.json</code> file for{' '}
          <strong className="text-fg">{label}</strong> will contain your API key in plaintext so it
          can be re-imported as-is. Anyone who opens this file can spend your key — store it
          somewhere safe, and don't share or sync it to cloud drives unintentionally.
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-line px-4 py-2 text-sm text-muted transition-colors hover:text-fg"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="inline-flex items-center gap-1.5 rounded-md border border-accent bg-accent-soft px-4 py-2 text-sm font-medium text-accent transition-colors hover:bg-accent hover:text-white"
          >
            <Download className="h-4 w-4" /> Export with key
          </button>
        </div>
      </div>
    </div>
  )
}
