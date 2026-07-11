interface OfflineBadgeProps {
  online: boolean
  /** Whether the active voice model is cached for offline use. */
  ready: boolean
}

/**
 * Compact connectivity + offline-readiness indicator for the voice section.
 * - offline → amber "Offline"
 * - online + ready → accent "Ready offline"
 * - online + not ready → muted "Voice not downloaded"
 */
export function OfflineBadge({ online, ready }: OfflineBadgeProps) {
  if (!online) {
    return <Badge className="bg-amber-500" label="Offline" />
  }
  if (ready) {
    return <Badge className="bg-accent" label="Ready offline" />
  }
  return <Badge className="bg-muted" label="Voice not downloaded" />
}

function Badge({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
      <span className={`inline-block h-2 w-2 rounded-full ${className}`} aria-hidden />
      {label}
    </span>
  )
}
