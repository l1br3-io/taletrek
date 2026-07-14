import { AlertTriangle, KeyRound } from 'lucide-react'
import { useEffect, useState } from 'react'

const SKIP_FLAG = 'tt:keySaveWarnDismissed'

/** Whether the user previously asked to silence the save-time key warning. */
export function shouldSkipKeySaveWarning(): boolean {
  try {
    return localStorage.getItem(SKIP_FLAG) === '1'
  } catch {
    return false
  }
}

function rememberSkip(): void {
  try {
    localStorage.setItem(SKIP_FLAG, '1')
  } catch {
    /* localStorage may be unavailable (private mode) — warn every time instead */
  }
}

interface KeySaveWarningDialogProps {
  open: boolean
  /** Called with true when the user acknowledges (and whether to silence next time). */
  onConfirm: (dontRemind: boolean) => void
  onCancel: () => void
}

/**
 * One-time-ish reminder shown when saving a cloud provider that has an API key
 * loaded in memory. Reinforces ADR-0004: the provider config is written to this
 * device, but the key itself is never persisted — it lives only for this tab
 * and is cleared on close.
 */
export function KeySaveWarningDialog({ open, onConfirm, onCancel }: KeySaveWarningDialogProps) {
  const [dontRemind, setDontRemind] = useState(false)

  useEffect(() => {
    if (!open) setDontRemind(false)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open) return null

  const handleConfirm = (): void => {
    if (dontRemind) rememberSkip()
    onConfirm(dontRemind)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="API key is not saved"
    >
      <div className="w-full max-w-md space-y-4 rounded-xl border border-warning/50 bg-surface p-5 shadow-2xl">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-warning" />
          <h2 className="text-base font-semibold text-fg">Your API key won't be saved</h2>
        </div>
        <p className="text-sm text-muted">
          The provider config (URL, model, label) will be saved to this device. The{' '}
          <strong className="text-fg">API key is never written to disk</strong> — it stays in memory
          for this tab only and is cleared when you close the tab. You'll need to paste it again
          next session.{' '}
          <span className="inline-flex items-center gap-1">
            <KeyRound className="h-3.5 w-3.5" />
            Keys are kept this way on purpose for your safety.
          </span>
        </p>
        <label className="flex items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={dontRemind}
            onChange={(e) => setDontRemind(e.target.checked)}
            className="h-4 w-4 rounded border-line"
          />
          Don't remind me again
        </label>
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
            onClick={handleConfirm}
            className="rounded-md border border-accent bg-accent-soft px-4 py-2 text-sm font-medium text-accent transition-colors hover:bg-accent hover:text-white"
          >
            Save provider
          </button>
        </div>
      </div>
    </div>
  )
}
