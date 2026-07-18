/**
 * Pluggable mobile playback engines (ADR-0010 / M11).
 *
 * Two engines sit behind `resolveMobileEngine`:
 *
 * - `'web-audio'` (native, default): decodes + schedules paragraph WAVs already
 *   in M8's `audioCache` on an `AudioContext`. Performs no encode — no 30 MB
 *   FFmpeg core download, no `encoding` phase, no duplicate m4a storage, no
 *   ~7 h cap. Accepts the same lock-screen limitation as the MSE `<video>` path
 *   (`AudioContext` suspends on iOS lock; user taps play to resume).
 * - `'ffmpeg'` (fallback): the M8.1 whole-book m4a path — concat worker +
 *   FFmpeg WASM encode → hidden `<video>` playback. Kept for devices where the
 *   Web Audio spike (see `docs/spikes/web-audio-mobile.md`) proves unreliable.
 *
 * Two consumers of one resolution:
 *   1. `usePlayer` (playback): picks `useWebAudioPlayer` vs `usePreloadedPlayer`.
 *   2. `uploadManager.runJob` (encode gate): runs the m4a encode only when the
 *      resolved engine is `'ffmpeg'`.
 *
 * ADR-0006 rejected Web Audio ("AudioContext suspends when tab hidden on iOS").
 * ADR-0010 supersedes that rejection on lock-suspend → tap-resume parity with
 * the MSE path's accepted limitation.
 */

export type PlaybackEngineId = 'web-audio' | 'ffmpeg'

/**
 * Stored setting. `'auto'` resolves to the first supported engine in preference
 * order (Web Audio first). Explicit choices are honoured when supported.
 */
export type PlaybackEngineSetting = 'auto' | PlaybackEngineId

export interface EngineCapability {
  /** Engine id — matches a {@link PlaybackEngineId}. */
  id: PlaybackEngineId
  /** Short label for the settings picker. */
  label: string
  /** One-line description for the settings picker. */
  description: string
  /** Whether this engine can run on the current device. Lazy — called at use. */
  supported: () => boolean
}

/**
 * Preference order for `'auto'` resolution. Web Audio is preferred because it
 * performs no encode (no 30 MB download, no duplicate storage, no cap).
 */
export const ENGINE_PREFERENCE: readonly PlaybackEngineId[] = ['web-audio', 'ffmpeg']

/** Codec string the FFmpeg engine's `<video>` must be able to decode. */
const MSE_CODEC_HINT = 'audio/mp4; codecs="mp4a.40.2"'

// ── Pure capability predicates (testable without DOM gymnastics) ────────────

/**
 * Whether the Web Audio API is available. Accepts an injected constructor so
 * tests don't need to pollute the global AudioContext.
 */
export function webAudioSupported(
  audioCtor: unknown = typeof AudioContext !== 'undefined'
    ? AudioContext
    : typeof window !== 'undefined'
      ? (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext
      : undefined,
): boolean {
  return typeof audioCtor === 'function'
}

/**
 * Whether the FFmpeg whole-book m4a engine can run: needs `<video>` that can
 * decode AAC-in-mp4 (for `usePreloadedPlayer`) AND OPFS (to cache the ~30 MB
 * FFmpeg core for the encode). Accepts injected probes for testing.
 */
export function ffmpegSupported(
  opts: { canPlayType?: (type: string) => string; hasOpfs?: boolean } = {},
): boolean {
  let canPlayResult: string
  if (opts.canPlayType) {
    canPlayResult = opts.canPlayType(MSE_CODEC_HINT)
  } else if (typeof document !== 'undefined') {
    canPlayResult = document.createElement('video').canPlayType(MSE_CODEC_HINT)
  } else {
    canPlayResult = ''
  }
  const hasOpfs =
    opts.hasOpfs ??
    (typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function')
  return canPlayResult !== '' && hasOpfs
}

/**
 * Session-level capability cache. Probing (especially `ffmpegSupported`, which
 * constructs a `<video>` element) is **never** safe to do per-render —
 * `usePlayer` calls `resolveMobileEngine` on every render, and during a long
 * synth the reader re-renders per paragraph, so per-render probing would create
 * hundreds of discarded `<video>` elements and OOM iOS. Capabilities never
 * change during a session, so compute once and memoize.
 *
 * The try/catch also defends against rare Safari/iOS edge cases where
 * `document.createElement('video')` can throw under extreme memory pressure.
 */
let cachedSupport: Record<PlaybackEngineId, boolean> | null = null

function detectSupport(): Record<PlaybackEngineId, boolean> {
  if (cachedSupport) return cachedSupport
  try {
    cachedSupport = { 'web-audio': webAudioSupported(), ffmpeg: ffmpegSupported() }
  } catch {
    cachedSupport = { 'web-audio': webAudioSupported(), ffmpeg: false }
  }
  return cachedSupport
}

/** Test-only: clear the capability cache. */
export function _resetEngineSupportCacheForTests(): void {
  cachedSupport = null
}

/**
 * Production capability registry. `supported()` reads the session cache — never
 * re-probes — so it's cheap to call from hot paths (every `usePlayer` render).
 */
export const MOBILE_ENGINES: EngineCapability[] = [
  {
    id: 'web-audio',
    label: 'Web Audio',
    description: 'Native engine — no download, sample-accurate gapless.',
    supported: () => detectSupport()['web-audio'],
  },
  {
    id: 'ffmpeg',
    label: 'FFmpeg',
    description: 'Compatibility engine — downloads a ~30 MB core on first use.',
    supported: () => detectSupport().ffmpeg,
  },
]

/**
 * Resolve the effective engine for a setting + capability set.
 *
 * - `'auto'` → first supported engine in {@link ENGINE_PREFERENCE} (Web Audio).
 * - explicit → honoured if supported; otherwise the other engine, with a
 *   `console.info` so the fallback is observable. If **neither** is supported
 *   (very old browser), falls back to Web Audio (the lighter assumption — the
 *   caller is expected to gate playback on coarse-pointer devices separately).
 *
 * Pure: pass `caps` in tests to avoid touching the DOM.
 */
export function resolveMobileEngine(
  setting: PlaybackEngineSetting,
  caps: readonly EngineCapability[] = MOBILE_ENGINES,
): PlaybackEngineId {
  const supported = (id: PlaybackEngineId) => caps.find((c) => c.id === id)?.supported() ?? false

  if (setting !== 'auto') {
    if (supported(setting)) return setting
    const fallback = ENGINE_PREFERENCE.find((id) => id !== setting && supported(id))
    if (fallback) {
      console.info(
        `[taletrek] playback engine '${setting}' not supported on this device — using '${fallback}'.`,
      )
      return fallback
    }
  }

  return ENGINE_PREFERENCE.find((id) => supported(id)) ?? 'web-audio'
}
