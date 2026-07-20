import { AlertTriangle, WifiOff } from 'lucide-react'

export type AiUnusableReason = 'no-provider' | 'no-key' | 'misconfigured' | 'offline'

interface AiStatusChipProps {
  reason: AiUnusableReason
  onOpenSettings: () => void
}

/**
 * Ambient one-line banner shown above the library list when AI is enabled in
 * settings but not actually usable right now. Non-dismissible — it represents
 * a real state of the system and stays until that state changes (provider
 * added, key entered, connection restored, or AI turned off). The "fix" is the
 * action the chip points at, not a dismiss button.
 *
 * Four reasons, four copies:
 *  - `no-provider`: AI is on but no provider configured → Settings → AI
 *  - `no-key`: provider configured but its API key isn't loaded in the
 *    in-memory keyring (never entered, or tab restarted without biometric
 *    caching) → Settings → AI to re-enter
 *  - `misconfigured`: a provider is selected but the engine can't resolve it
 *    (bad URL) → Settings → AI to check it
 *  - `offline`: transient; OS already shows offline status, but the chip says
 *    *why* the AI features are paused. No Settings link — reconnecting is the
 *    fix, so we just say so.
 */
export function AiStatusChip({ reason, onOpenSettings }: AiStatusChipProps) {
  const Icon = reason === 'offline' ? WifiOff : AlertTriangle
  const message = MESSAGES[reason]
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="flex-1 leading-relaxed">
        {message.text}{' '}
        {message.action ? (
          <button
            type="button"
            onClick={onOpenSettings}
            className="font-medium underline underline-offset-2 transition-colors hover:text-amber-700"
          >
            {message.action}
          </button>
        ) : null}
      </span>
    </div>
  )
}

const MESSAGES: Record<AiUnusableReason, { text: string; action: string | null }> = {
  'no-provider': {
    text: 'AI is on but no provider is set.',
    action: 'Add one in Settings → AI.',
  },
  'no-key': {
    text: "Active provider's API key isn't loaded.",
    action: 'Re-enter it in Settings → AI.',
  },
  misconfigured: {
    text: "AI provider isn't responding.",
    action: 'Check Settings → AI.',
  },
  offline: {
    text: "You're offline. AI features will return when you reconnect.",
    action: null,
  },
}
