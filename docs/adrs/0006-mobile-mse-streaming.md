# ADR-0006: Mobile MSE Video Streaming

- **Status:** Accepted
- **Date:** 2026-07-15
- **Companion:** [`../specs/mobile-streaming-deferred/spec.md`](../specs/mobile-streaming-deferred/spec.md)

## Context

M3's per-paragraph playback (each paragraph = separate `<audio>` `src`, advanced via `onEnded → loadAndPlay`) works on desktop and through tab-backgrounding. On **iOS Safari with a locked screen**, it fails: the current paragraph finishes, then silence. iOS allows the *currently playing* media item to continue through a lock, but **blocks JavaScript from starting a new media source** (`src = newUrl; play()`) without a user gesture. The `ended → next paragraph` chain in `useParagraphPlayer.ts:463` cannot proceed on a locked phone.

Several alternatives were evaluated and rejected:

| Alternative | Why rejected |
| --- | --- |
| **PCM-stitch chunks** (~5-min, swap at boundaries) | Same fundamental problem — swapping `src` + `play()` on chunk boundary is blocked on lock. Gaps are less frequent (every ~5 min instead of every ~30s) but not eliminated. |
| **Whole-chapter blob** (one big WAV `src`) | Memory: ~80–160 MB PCM per chapter. OOM risk on low-end devices. No compression. |
| **Service Worker streaming** (virtual URL, SW reads IDB → `ReadableStream`) | Theoretically elegant (zero `src` changes), but iOS Safari's behavior with progressively-arriving SW stream responses consumed by `<audio>` is **unproven**. SW lifecycle during 30+ min playback is unknown. |
| **Web Audio API** (`AudioContext` + scheduled buffers) | `AudioContext` **suspends** when tab hidden on iOS. Not viable. |
| **MediaSource Extensions on `<audio>`** | iOS Safari does **not** support MSE for `<audio>` elements — only `<video>`. |
| **Wake Lock only** | Prevents auto-lock from inactivity but does NOT override manual hardware lock button. Complementary, not a solution. |

## Decision

**Add a separate mobile playback engine using MediaSource Extensions (MSE) on a hidden `<video>` element, fed progressively via FFmpeg WASM-encoded fMP4 segments.**

The mobile engine is a **parallel code path** — desktop playback (`useParagraphPlayer` + per-paragraph `<audio>`) is unchanged. A `matchMedia('(pointer: coarse)')` check selects which engine `ReaderPane` uses. Both return the same `UseParagraphPlayerResult` interface, so UI components are shared without modification.

### Pipeline

**Synthesis-time encoding (background, per paragraph):**

1. Piper TTS produces PCM WAV (22050 Hz mono 16-bit) — unchanged.
2. FFmpeg WASM (`@ffmpeg/ffmpeg` latest, single-threaded core) encodes WAV → fragmented MP4 (AAC audio + 1x1 black H.264 video frame).
3. The fMP4 segment is cached in a new IDB `audioSegments` store (DB v4), keyed identically to M8's `audioCache`.

**Playback-time streaming:**

1. Read fMP4 segments from IDB.
2. Create `MediaSource` → assign to a hidden `<video>` element's `src` (set once, never changed).
3. On `sourceopen`: create `SourceBuffer`, append init segment, append first paragraph segment, `video.play()`.
4. Progressively `appendBuffer` subsequent segments before the buffer runs low, using `SourceBuffer.timestampOffset` for correct sequencing.
5. `timeupdate` → binary search precomputed paragraph time offsets → highlight current paragraph.

### Key choices

| Choice | Rationale |
| --- | --- |
| **`<video>` not `<audio>`** | iOS Safari supports MSE only on `<video>` elements. The element is hidden (`display: none`) — user sees only the audio player UI. |
| **1x1 black H.264 frame** | iOS Safari's MSE may reject audio-only fMP4. A static 1x1 black frame at 1fps satisfies the video-track requirement with negligible size/encode overhead. Future optimization: if audio-only MSE is proven to work on iOS, the video track can be dropped. |
| **FFmpeg WASM, not WebCodecs** | FFmpeg is the industry standard — reliable, well-tested, includes AAC + H.264 encoders. WebCodecs `AudioEncoder`/`VideoEncoder` on iOS Safari 16.4+ is less proven. The trade-off is size (~30MB WASM core), mitigated by OPFS caching. |
| **Single-threaded FFmpeg core** | Avoids the `SharedArrayBuffer` / cross-origin isolation (COOP/COEP) requirement. Encoding short speech clips is fast enough single-threaded. |
| **OPFS-cached FFmpeg core** | ~30MB WASM core downloaded to OPFS on first mobile playback (like Piper voice models), then loaded from OPFS on subsequent uses. Works offline. Seamless UX with progress indicator. |
| **Per-paragraph segments** | Each paragraph = one fMP4 segment. Clean paragraph-to-time-offset mapping for highlighting. MSE handles many small segments fine (one `appendBuffer` every 5–30s). |
| **Synthesis-time encoding** | Encoding cost paid once per paragraph and cached. At playback, segments are read from IDB → fed to MSE → instant playback start. No real-time encoding risk. |
| **Accepted lock-screen pause** | `<video>` elements pause when iOS screen locks. This is an accepted limitation — the user taps play when they return. No workaround attempted. The current paragraph resumes from where it left off. |

## Consequences

- **Positive:** Mobile users get gapless, streaming playback with full paragraph highlighting and navigation parity. The desktop experience is completely unchanged. The `TtsEngine` contract, M8 audio cache, and `MediaSessionPlayer` interface are untouched. Future optimization paths (audio-only MSE, HLS native, compression tuning) are open.
- **Negative:** ~30MB FFmpeg WASM core download on first mobile use (mitigated by OPFS caching). `<video>` pauses on iOS lock screen (accepted). AAC encoding is lossy (64kbps mono speech — quality is sufficient but not lossless). Two parallel playback engines to maintain (desktop + mobile).
- **New dependency:** `@ffmpeg/ffmpeg` (latest) — MIT licensed.
- **DB schema bump:** v3 → v4 (additive `audioSegments` store, no migration of existing records).
- **Reversibility:** The mobile engine is fully isolated behind the `UseParagraphPlayerResult` interface. If a better approach emerges (e.g., iOS ships audio MSE support), the mobile hook can be swapped without touching desktop, UI, or engine contracts.

## Alternatives considered

Evaluated and rejected before settling on MSE-on-`<video>` (full detail in Context above):

- **PCM-stitch chunks** — same `src`+`play()` lock problem at chunk boundaries.
- **Whole-chapter blob** — ~80–160 MB PCM per chapter, OOM risk, no compression.
- **Service Worker streaming** — unproven on iOS Safari for long-form `<audio>` consumption.
- **Web Audio API** — `AudioContext` suspends when tab hidden on iOS. Not viable. *(This rejection was later revisited and superseded by [ADR-0010](./0010-playback-engine-architecture.md), which accepts the same lock-pause parity as the MSE path.)*
- **MediaSource Extensions on `<audio>`** — iOS Safari supports MSE only on `<video>`.
- **Wake Lock only** — doesn't override manual lock button. Complementary, not a solution.
