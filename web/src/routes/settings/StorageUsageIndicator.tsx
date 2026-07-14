interface StorageUsageIndicatorProps {
  /** Bytes used by the origin, or null while loading / unavailable. */
  usageBytes: number | null
  /** Total quota in bytes, or null. */
  quotaBytes: number | null
}

/** Format bytes as a human-readable string (MB / GB). */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  }
  return `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`
}

/**
 * Read-only total-storage indicator for the Settings "Storage" group. Shows the
 * origin's total usage vs the browser's quota with a usage bar. Presentational
 * — the container owns the data via `useStorageEstimate`.
 */
export function StorageUsageIndicator({ usageBytes, quotaBytes }: StorageUsageIndicatorProps) {
  const hasQuota = quotaBytes !== null && quotaBytes > 0

  if (usageBytes === null) {
    return (
      <div className="space-y-2 rounded-lg border border-line p-3">
        <span className="text-sm text-fg">Total storage: …</span>
        <p className="text-xs text-muted">
          Includes your books, downloaded voice models, cached audio, and the app shell — the total
          this site stores on your device.
        </p>
      </div>
    )
  }

  const quota = hasQuota ? (quotaBytes as number) : 0
  const pct = hasQuota ? Math.min(100, (usageBytes / quota) * 100) : 0
  const nearLimit = hasQuota && pct >= 80
  const label = hasQuota
    ? `Total storage: ${formatBytes(usageBytes)} / ${formatBytes(quota)}`
    : `Total storage: ${formatBytes(usageBytes)}`

  return (
    <div className="space-y-2 rounded-lg border border-line p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-fg">{label}</span>
        {hasQuota && (
          <span className={['text-xs', nearLimit ? 'text-warning' : 'text-muted'].join(' ')}>
            {Math.round(pct)}%
          </span>
        )}
      </div>
      {hasQuota && (
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-elevated"
          role="progressbar"
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Storage usage"
        >
          <div
            className={[
              'h-full rounded-full transition-all',
              nearLimit ? 'bg-warning' : 'bg-accent',
            ].join(' ')}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      <p className="text-xs text-muted">
        Includes your books, downloaded voice models, cached audio, and the app shell — the total
        this site stores on your device.
      </p>
    </div>
  )
}
