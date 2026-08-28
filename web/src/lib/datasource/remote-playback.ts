/**
 * Remote playback engine (ADR-0014, Effort 5 · T15): the hosted reader's
 * `TtsEngine` slot. `synthesize` becomes an audio-by-key fetch — the content
 * key is computed by the **existing** `audioCacheKey` path
 * (`${voice}:${NORM_VERSION}:${sha256(normalized)}`), which the server's
 * bundle naming mirrors by construction (parity gate:
 * `lib/bundle/parity.test.ts` ↔ `crates/synth/src/cache_key.rs`).
 *
 * Both player stacks consume this through their normal engine calls, so
 * remote bytes flow the same paths the T3 bundle import proved:
 * - desktop — `AudioController.loadAndPlay(blob)` → `<audio>` element;
 * - mobile Web Audio — `arrayBuffer()` → `decodeAudioData` → scheduler.
 * The FFmpeg whole-book preloaded engine is local-only and never selected in
 * server mode (`ServerDatasource.getBookAudio` returns `undefined`).
 *
 * Nothing is written to the on-device audio cache: buffered indicators
 * reflect **server** knowledge (the T13 probe), not IDB, and the desktop
 * player / Web Audio scheduler keep their own in-session buffers.
 *
 * # Key parity depends on egress cleaning
 *
 * The server synthesizes the bundle's stored text, and the reader plays its
 * cleaned view of that text — keys only agree when the two strings are the
 * same. The hosted pipeline therefore applies the user's cleaning config to
 * the text-only bundle at upload time (`ingestBook`), making bundle text ==
 * reader text == key input. A cleaning-config change *after* upload is the
 * documented soft spot (same class as local mode's cache-key staleness):
 * affected paragraphs 404 until the book is re-uploaded or re-transformed.
 *
 * # 404 = "not synthesized yet", not a crash
 *
 * Read-ahead (`primeAhead`, scheduler lookahead) swallows the rejection
 * silently; playing an unsynthesized paragraph surfaces the error message
 * that points at the library's Synthesize affordance.
 */

import type { VoiceId } from '../../types'
import { audioCacheKey } from '../audio-cache'
import type { SynthesisRequest, SynthesisResult, TtsEngine, Voice } from '../tts/types'
import { api, HostedModeUnavailableError, ServerApiError } from './server'

/** What a missing key means to the user — names the real affordance. */
const MISSING_AUDIO_MESSAGE =
  'No audio for this paragraph on the server — run Synthesize on the book in the library first.'

export interface CreateServerPlaybackEngineOptions {
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

export function createServerPlaybackEngine(
  opts: CreateServerPlaybackEngineOptions = {},
): TtsEngine {
  // Lazy default: resolve the global at call time so tests can stub `fetch`
  // after the singleton exists.
  const f = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))

  return {
    async synthesize(req: SynthesisRequest): Promise<SynthesisResult> {
      if (req.bookId === undefined) {
        throw new Error('Hosted playback requires the paragraph’s book id.')
      }
      // Blank paragraphs are never synthesized server-side; skip the
      // guaranteed-404 round trip with a clearer message.
      if (!req.text.trim()) {
        throw new Error('This paragraph has no speakable text.')
      }
      // The existing key path — no reimplementation (keys match the server's
      // manifest naming by construction).
      const key = await audioCacheKey(req.voiceId, req.text)
      const t0 = performance.now()
      let res: Response
      try {
        // The key travels raw: `:` is a legal path-segment char (RFC 3986
        // pchar) and axum captures it verbatim — see server/src/http/audio.rs.
        res = await api(f, `/api/books/${encodeURIComponent(req.bookId)}/audio/${key}`)
      } catch (e) {
        if (e instanceof ServerApiError && e.status === 404) {
          throw new ServerApiError(MISSING_AUDIO_MESSAGE, 404)
        }
        throw e
      }
      const audio = await res.blob()
      return {
        audio,
        synthMs: performance.now() - t0,
        // Unknowable without decoding; the players derive duration themselves
        // (element / decoded buffer) and hosted playback never feeds the
        // pre-synth pipeline that consumes this field.
        durationSeconds: 0,
        cacheKey: key,
      }
    },

    async listVoices(): Promise<Voice[]> {
      // Hosted synthesis is server-side; no on-device voice catalog.
      return []
    },

    async isStored(_voiceId: VoiceId): Promise<boolean> {
      return false
    },

    async download(_voiceId: VoiceId): Promise<void> {
      throw new HostedModeUnavailableError('Downloading on-device voices')
    },

    async remove(_voiceId: VoiceId): Promise<void> {
      // Nothing is ever stored hosted — no-op.
    },

    async clearAllStored(): Promise<void> {
      // Nothing is ever stored hosted — no-op.
    },
  }
}

/** The reader's engine slot in server mode (ReaderPane wires this once). */
export const serverPlaybackEngine: TtsEngine = createServerPlaybackEngine()
