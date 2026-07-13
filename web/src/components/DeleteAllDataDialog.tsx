import { AlertTriangle, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'

interface DeleteAllDataDialogProps {
  open: boolean
  /** Called with true when the user confirms (typed DELETE); false to cancel. */
  onResult: (confirmed: boolean) => void
  /** Whether the wipe is in progress (disables buttons). */
  busy?: boolean
}

const CONFIRM_WORD = 'DELETE'

/**
 * Destructive-action confirmation modal for "Delete all data". The user must
 * type `DELETE` to enable the confirm button — a strong guard against
 * accidental loss (everything TaleTrek stores is wiped irreversibly).
 */
export function DeleteAllDataDialog({ open, onResult, busy = false }: DeleteAllDataDialogProps) {
  const [typed, setTyped] = useState('')

  useEffect(() => {
    if (!open) setTyped('')
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onResult(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, busy, onResult])

  if (!open) return null
  const canConfirm = typed.trim().toUpperCase() === CONFIRM_WORD

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="Delete all data"
    >
      <div className="w-full max-w-md space-y-4 rounded-xl border border-danger/50 bg-surface p-5 shadow-2xl">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-danger" />
          <h2 className="text-base font-semibold text-fg">Delete all data</h2>
        </div>
        <p className="text-sm text-muted">
          This permanently removes <strong className="text-fg">every book</strong>, downloaded voice
          model, cached audio, and all settings from this device. There is no undo — export a backup
          first if you want to keep your library.
        </p>
        <label className="block space-y-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">
            Type <span className="text-danger">{CONFIRM_WORD}</span> to confirm
          </span>
          <input
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            disabled={busy}
            aria-label={`Type ${CONFIRM_WORD} to confirm`}
            className="w-full rounded-md border border-line bg-bg px-3 py-2 text-sm font-mono"
          />
        </label>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onResult(false)}
            disabled={busy}
            className="rounded-md border border-line px-4 py-2 text-sm text-muted transition-colors hover:text-fg disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onResult(true)}
            disabled={!canConfirm || busy}
            className="inline-flex items-center gap-1.5 rounded-md border border-danger bg-danger/10 px-4 py-2 text-sm font-medium text-danger transition-colors hover:bg-danger hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? (
              'Deleting…'
            ) : (
              <>
                <Trash2 className="h-4 w-4" /> Delete everything
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
