import { Square } from 'lucide-react'
import { useEffect, useState } from 'react'

/**
 * Mono eyebrow chip rendered above a streaming paragraph (F8 per-paragraph
 * transform) or the first in-place streaming slot of an M13 whole-book
 * transform.
 *
 * Visual signature: `❯ {opLabel} ───── ■ Stop`
 *
 * The Stop button is optional — the F8 per-paragraph stream always renders
 * it; the M13 whole-book stream uses a single global Stop in the reader
 * header instead, so M13 callers pass `onStop={undefined}`.
 *
 * Presentational only — no state, no side effects.
 */
export function StreamChip({
  opLabel,
  onStop,
  'data-testid': dataTestId,
}: {
  opLabel: string
  onStop?: () => void
  'data-testid'?: string
}) {
  return (
    <div
      className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.08em] text-accent"
      data-testid={dataTestId ?? 'stream-chip'}
    >
      <span aria-hidden>❯</span>
      <span>{opLabel}</span>
      <span aria-hidden className="mx-1 flex-1 border-b border-dotted border-line" />
      {onStop && (
        <button
          type="button"
          onClick={onStop}
          className="inline-flex items-center gap-1 rounded-md border border-accent px-2 py-0.5 text-[11px] uppercase tracking-[0.08em] text-accent transition-colors hover:bg-accent hover:text-bg"
          aria-label={`Stop ${opLabel}`}
        >
          <Square className="h-2.5 w-2.5 fill-current" aria-hidden />
          Stop
        </button>
      )}
    </div>
  )
}

/**
 * Blinking `█` cursor rendered at the tail of a streaming paragraph or
 * chunk block. Uses the existing `.tt-cursor` animation; color flows from
 * `text-accent` (caller sets via `className` if needed).
 *
 * `aria-hidden` because the streaming `<p>` is `aria-live="off"` to keep
 * token-flood out of the announcement queue; a sibling SR-only status
 * region does the polite announcement.
 */
export function StreamingCursor({ className = '' }: { className?: string }) {
  return (
    <span className={`tt-cursor text-accent ${className}`.trim()} aria-hidden>
      █
    </span>
  )
}

/**
 * Inline CSS spinner — same visual as the synth banner's
 * (`GlobalUploadBanner.tsx`). `border-t-transparent` leaves one quadrant
 * missing so the ring reads as a spinner when `animate-spin` rotates it.
 */
export function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent ${className}`.trim()}
      aria-hidden
    />
  )
}

/**
 * Live elapsed-seconds counter for the M13 preparing state. Ticks every 1s.
 * Renders `{N}s elapsed` so the user knows the request is still in flight
 * (and can decide whether to keep waiting or Cancel). Resets on `startedAt`
 * change (per-chapter). Used by the unified bottom PlayerBar (generation
 * mode — see `GenerationBar` in `PlayerBar.tsx`) AND the inline chapter
 * preparing chip — both render simultaneously (banner may be scrolled out
 * of view); both derive the same elapsed from `performance.now()`.
 *
 * Provider first-token latency can be minutes on slow / free-tier models
 * (z.ai glm-4.7 measured 268s on 2026-07-20) — without an elapsed counter
 * the user assumes the app is hung.
 */
export function PreparingElapsedTimer({ startedAt }: { startedAt: number }) {
  const [elapsedSec, setElapsedSec] = useState(() =>
    Math.max(0, Math.round((performance.now() - startedAt) / 1000)),
  )
  useEffect(() => {
    const id = setInterval(() => {
      setElapsedSec(Math.max(0, Math.round((performance.now() - startedAt) / 1000)))
    }, 1000)
    return () => clearInterval(id)
  }, [startedAt])
  return (
    <span className="font-mono text-[10px] text-accent/70" data-testid="preparing-elapsed">
      {elapsedSec}s elapsed
    </span>
  )
}
