import { AlertTriangle, WifiOff } from 'lucide-react'
import { useEffect } from 'react'
import type { AiUnusableReason } from './AiStatusChip'

export type UnavailableFeature = 'transform' | 'pronunciation'

interface FeatureUnavailableSheetProps {
  open: boolean
  feature: UnavailableFeature
  reason: AiUnusableReason
  onClose: () => void
  onOpenSettings: () => void
}

/**
 * Small explanatory sheet shown when the user clicks a Transform / Pronunciation
 * menu item while AI is enabled but unusable. Replaces the old "hide the menu
 * item entirely" behaviour — the user opted in to AI, so the feature stays
 * visible; we just tell them what's missing and how to fix it.
 *
 * Two actions only: `Not now` (close, do nothing) and `Open AI settings`
 * (navigate to `/settings`). When the reason is `offline`, the Settings button
 * is suppressed — reconnecting is the fix, not a config change.
 */
export function FeatureUnavailableSheet({
  open,
  feature,
  reason,
  onClose,
  onOpenSettings,
}: FeatureUnavailableSheetProps) {
  // Escape closes.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const Icon = reason === 'offline' ? WifiOff : AlertTriangle
  const title = TITLES[feature]
  const body = BODIES[reason](feature)
  const showSettings = reason !== 'offline'

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="feature-unavailable-title"
    >
      <div className="w-full max-w-sm space-y-3 rounded-xl border border-line bg-surface p-5">
        <div className="flex items-start gap-2">
          <Icon className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden />
          <h2 id="feature-unavailable-title" className="text-base font-semibold text-fg">
            {title}
          </h2>
        </div>
        <p className="text-sm leading-relaxed text-muted">{body}</p>
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-muted transition-colors hover:border-muted"
          >
            Not now
          </button>
          {showSettings && (
            <button
              type="button"
              onClick={onOpenSettings}
              className="rounded-md border border-accent bg-accent px-3 py-1.5 text-sm font-medium text-bg transition-colors hover:bg-accent-strong"
            >
              Open AI settings
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

const TITLES: Record<UnavailableFeature, string> = {
  transform: 'Transform needs a provider',
  pronunciation: 'Pronunciation review needs a provider',
}

const BODIES: Record<AiUnusableReason, (feature: UnavailableFeature) => string> = {
  'no-provider': (f) =>
    `AI is on, but no provider is configured yet. Add one in Settings → AI to use ${
      f === 'transform' ? 'transforms' : 'pronunciation review'
    }.`,
  'no-key': (f) =>
    `AI is on, but the active provider's API key isn't loaded. Re-enter it in Settings → AI to use ${
      f === 'transform' ? 'transforms' : 'pronunciation review'
    }.`,
  misconfigured: (f) =>
    `AI is on, but the selected provider isn't responding. Check Settings → AI to use ${
      f === 'transform' ? 'transforms' : 'pronunciation review'
    }.`,
  offline: () =>
    "You're offline. AI features will return as soon as you reconnect — no settings change needed.",
}
