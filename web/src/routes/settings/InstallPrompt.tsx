import { Download } from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'
import {
  type BeforeInstallPromptEvent,
  getInstallState,
  isIOS,
  subscribe,
  triggerInstallPrompt,
} from '../../lib/install-prompt'

const DISMISS_KEY = 'tt.install.dismissed'

function readDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

function writeDismissed() {
  try {
    localStorage.setItem(DISMISS_KEY, '1')
  } catch {
    // ignore (private mode / disabled storage)
  }
}

/**
 * Install affordance. Consumes the module-load `beforeinstallprompt` capture
 * in `lib/install-prompt.ts` — late subscriptions still see an event that
 * fired before React mounted (the pre-2026-07 pattern missed early events on
 * Android and the button never appeared). On Chromium it offers a one-tap
 * install; on iOS (which never fires that event) it shows the manual
 * "Share → Add to Home Screen" instructions. Hidden once installed or
 * dismissed (sticky via localStorage).
 */
export function InstallPrompt() {
  const { captured, installed } = useSyncExternalStore(subscribe, getInstallState)
  const [dismissed, setDismissed] = useState<boolean>(() => readDismissed())

  const dismiss = () => {
    setDismissed(true)
    writeDismissed()
  }

  const prompt = async () => {
    await triggerInstallPrompt()
  }

  if (installed || dismissed) return null

  const ios = isIOS() && !captured
  if (!ios && !captured) return null

  return (
    <section className="flex items-start gap-3 rounded-lg border border-line bg-surface p-4">
      <p className="flex-1 text-sm text-fg">
        <strong>Install TaleTrek.</strong>{' '}
        <span className="text-muted">
          {ios ? (
            <>
              Tap the Share button, then “Add to Home Screen” for a full-screen, offline experience.
            </>
          ) : (
            <>Full-screen, offline reading — right from your home screen.</>
          )}
        </span>
      </p>
      <div className="flex shrink-0 items-center gap-2">
        {!ios && (
          <button
            type="button"
            onClick={() => void prompt()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-accent bg-accent-soft px-3 py-1.5 text-sm font-medium text-accent transition-colors hover:bg-elevated"
          >
            <Download className="h-4 w-4" /> Install
          </button>
        )}
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss install prompt"
          className="rounded-md border border-line px-2 py-1.5 text-xs text-muted transition-colors hover:text-fg"
        >
          Not now
        </button>
      </div>
    </section>
  )
}

// Re-export so existing call sites that imported the type from this module
// still compile (the canonical home is now `lib/install-prompt`).
export type { BeforeInstallPromptEvent }
