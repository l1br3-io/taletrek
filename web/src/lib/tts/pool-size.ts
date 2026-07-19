import { isMobileDevice } from '../platform'

/**
 * Maximum parallel synth workers for `PoolEngine` (ADR-0011 / parallel
 * synthesis). Sized once at pool construction; the value doesn't change
 * mid-session.
 *
 * - **Mobile = 2.** iOS Safari's per-tab worker memory budget caps the pool —
 *   each resident Piper model is ~63 MB plus the per-call Emscripten MEMFS
 *   snapshot (~18 MB espeak-ng-data). A pool of 2 is the largest size that
 *   doesn't reliably OOM under typical mobile conditions (see
 *   `docs/spikes/piper-wasm.md`, gotcha #3 / iOS worker memory pressure). The
 *   ≈2× speedup is also where it matters most: mobile CPUs are slower, and
 *   the FFmpeg whole-book encode is gated on a 200 MB cap that long books
 *   exceed.
 * - **Desktop = `min(navigator.hardwareConcurrency ?? 4, 8)`.** ORT predict is
 *   CPU-bound single-threaded WASM under our no-COOP/COEP constraint
 *   (gotcha #1 / ORT 1.18.0 pinning; ADR-0006 / no cross-origin isolation), so
 *   one worker per logical core maximises throughput up to a sane cap.
 */
export function preferredPoolSize(): number {
  if (isMobileDevice()) return 2
  const hc =
    typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency ?? undefined) : undefined
  return Math.min(hc ?? 4, 8)
}
