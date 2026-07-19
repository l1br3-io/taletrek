/**
 * Platform detection shared across modules (upload manager, TTS pool sizing).
 *
 * "Mobile" is intentionally a coarse heuristic — `pointer: coarse` — matching
 * the upload manager's existing use (gating the FFmpeg whole-book encode) and
 * the parallel-synthesis pool's sizing (mobile → smaller worker pool, see
 * `lib/tts/pool-size.ts`). Touchscreen laptops (rare) report coarse; the cost
 * is conservative sizing, not a wrong decision.
 *
 * Centralised so callers don't each re-implement the `matchMedia` probe (and
 * so tests can stub one place).
 */
export function isMobileDevice(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches
}
