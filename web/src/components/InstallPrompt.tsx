import { useEffect, useState } from 'react'

const DISMISS_KEY = 'tt.install.dismissed'

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as { standalone?: boolean }).standalone === true
  )
}

function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
}

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
 * Install affordance. On Chromium it captures `beforeinstallprompt` and offers
 * a one-tap install; on iOS (which never fires that event) it shows the manual
 * "Share → Add to Home Screen" instructions. Hidden once installed (standalone)
 * or dismissed (sticky via localStorage).
 */
export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null)
  const [installed, setInstalled] = useState<boolean>(() => isStandalone())
  const [dismissed, setDismissed] = useState<boolean>(() => readDismissed())

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault()
      setDeferred(e as BeforeInstallPromptEvent)
    }
    const onInstalled = () => {
      setInstalled(true)
      setDeferred(null)
    }
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  const dismiss = () => {
    setDismissed(true)
    writeDismissed()
  }

  const prompt = async () => {
    if (!deferred) return
    await deferred.prompt()
    await deferred.userChoice
    setDeferred(null)
  }

  if (installed || dismissed) return null

  const ios = isIOS() && !deferred
  if (!ios && !deferred) return null

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
            className="rounded-lg border border-accent bg-accent-soft px-3 py-1.5 text-sm font-medium text-accent transition-colors hover:bg-elevated"
          >
            Install
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
