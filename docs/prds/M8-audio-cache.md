# PRD: M8 — Audio Cache

> **Status:** Ready to implement.
> **Companions:** [`../VISION.md`](../VISION.md), [`../ROADMAP.md`](../ROADMAP.md), [`M3-jog.md`](M3-jog.md), [`M5-library-offline.md`](M5-library-offline.md), [`../spikes/piper-wasm.md`](../spikes/piper-wasm.md).

## Objective

Close the gap between M5's "resume anywhere" promise and the reality that **every paragraph re-synthesizes on every session.** `PiperEngine.synthesize` (`web/src/lib/tts/engine.ts:39`) is stateless, and `useParagraphPlayer`'s only buffer is an in-memory look-ahead `Map` (default 3, cleared on voice/text change, unmount, reload). Reopening a book at the 1,000th paragraph pays ~1 s × N of Piper WASM inference the device has already done once — burning the jogger's battery and CPU.

Add a **persistent, content-addressed audio cache** so a paragraph synthesized once is reused across sessions, voice changes, and app reinstalls (within the browser's storage window). The cache is a **local optimization**: no sync, no upload, no new permission, no cloud. If evicted, the app transparently re-synthesizes — the uploaded file stays the source of truth (existing gotcha #2 invariant).

**User story:** *As a reader, I listen to chapter 12, close the app, reopen it three days later, tap play, and audio starts instantly — the device doesn't re-render five hours of speech it already computed. My phone stays cool. When I switch voices and switch back, the old audio is still there. I can see how much space the cache uses and clear it from Settings.*

### Industry context (what informed this design)

| Reference | Lesson |
| --------- | ------ |
| Home Assistant + Wyoming-Piper (canonical on-device Piper deploy) | Two-tier content-addressed cache: in-memory hot window + filesystem LRU keyed by `sha1(text)+lang+engine`. The closest reference architecture. |
| `@mintplex-labs/piper-tts-web` | Caches voice *models* in OPFS only — **audio caching is explicitly the app's job** (rhasspy/piper#352). |
| Voice Dream / Speechify / NaturalReader | Cache only *cloud* TTS (network cost). OS-engine TTS is "free" so they don't cache. TaleTrek is **unique** — its on-device neural model makes caching compute-driven, not network-driven. |
| KOReader / Librera | No on-device model → no audio cache at all. Not applicable. |

**Pattern selected: D (hybrid memory + persistent content-addressed).** Tier 1 (M3's in-memory queue) is unchanged; tier 2 is a new IndexedDB store.

## Decisions (locked)

| Area | Decision |
| ---- | -------- |
| Tier 1 (memory) | **Unchanged.** `useParagraphPlayer`'s `lookahead=3` `Map<paraId, PrerenderedChunk>` stays exactly as shipped in M3. The cache sits *below* it. |
| Tier 2 (persistent) | **New IndexedDB `audioCache` store** in the existing `taletrek` DB. Not OPFS, not Cache API. |
| `DB_VERSION` | **Bump 2 → 3.** M5 deliberately avoided this; M8 is the first legitimate need. Additive store only; no migration of existing records. |
| Storage backend | **IndexedDB** — already wrapped by `idb`, schema-versioned, supports indexed queries (`byBookId`, `byLastUsed`) needed for eviction. OPFS would force a parallel IDB metadata index anyway; chunks are small (~300 KB/para per the spike) so IDB per-record overhead is negligible. |
| Cache key | `${voiceId}:${NORM_VERSION}:${sha256(normalizeForSpeech(text))}`. Every synthesis input is in the key. |
| Key excludes `playbackRate` | **Rate is applied live** on the `<audio>` element (`useParagraphPlayer.ts:363`), not baked into the WAV. One blob serves any speed. |
| `NORM_VERSION` | **New exported constant from `normalize.ts`** (initial value `'1'`). Bumping it cleanly invalidates the entire cache when speech-normalization logic changes. |
| Hash of normalized text (not raw) | **`normalizeForSpeech(text)` is what's actually synthesized** (`engine.ts:43`). Hashing the normalized form means two source paragraphs that normalize to the same string share one cache entry. |
| Lookup site | **Inside `PiperEngine.synthesize`** (`engine.ts:39`), in the worker. The worker already owns the IDB-shaped workload; cache check → `predict()` on miss → `put`. The main thread, `useParagraphPlayer`, and the protocol are unchanged. |
| `TtsEngine` contract | **Unchanged.** `synthesize(req)` still returns `{ audio, synthMs }`. The cache is an internal optimization of `PiperEngine` — the interface, protocol, worker message shape, and `TtsClient` are untouched. This keeps the engine swappable and the stub-test path identical. |
| `synthMs` semantics | **On cache hit, `synthMs` reports 0** (near-zero compute). On miss it reports the real inference wall-clock time. Diagnostics stay honest. |
| `bookId` threading | **Add optional `bookId?: BookId` to `SynthesisRequest`.** The reader threads it through; entries without `bookId` are still cached (just not cascade-cleared; LRU reaps them). The worker protocol and `TtsClient` pass it through opaquely. |
| Budget | **500 MB soft cap** (~1,700 paragraphs ≈ one long book fully cached). Not user-configurable in v1. |
| Eviction trigger | **Reactive, on write + quota error.** After each successful `put`, if total > budget, sweep oldest by `lastUsed` until under. Every `put` is wrapped in try/catch — on `QuotaExceededError`, evict half the cache by `lastUsed` and retry once. No `requestIdleCallback` (unreliable on iOS Safari background). |
| Per-book clear | **Extend `deleteBookCascade`** to also delete `audioCache` entries by `bookId` index, in the same atomic transaction. |
| Invalidation on voice/text change | **None needed.** Entries are content-addressed — voice change naturally misses; stale entries (old voice) are dead keys the LRU reaps. No explicit `clear()` on the M3 invalidation hooks. Correctness is impossible to violate. |
| Settings UX | **Read-only indicator + Clear button**, in Settings → "Storage" subsection (alongside the existing "Voices & offline"). Shows "Cached audio: 412 MB / 500 MB" and a Clear button. Pairs with the existing `OfflineBadge`. |
| Per-book cache view | **Non-goal (v1).** No per-book breakdown in the library. A single global total + Clear suffices; LRU handles fairness. |
| Licensing | ADR-0002 (MIT pipeline) unchanged; no new dependencies. |

## Technologies (additions to M0–M7)

| Package | Version | License | Purpose |
| ------- | ------- | ------- | ------- |
| — | — | — | **No new dependencies.** Uses existing `idb`, existing `PiperEngine`, existing Settings infrastructure, and the browser's `SubtleCrypto.sha256` (`crypto.subtle`, available in workers). |

Adding dependencies is ask-first per M0 boundaries.

## Domain model (additions)

### DB schema (v3)

```ts
export interface TaleTrekDB extends DBSchema {
  settings: { ... }      // unchanged
  books: { ... }         // unchanged
  chapters: { ... }      // unchanged
  files: { ... }         // unchanged
  audioCache: {          // NEW — v3
    key: string          // `${voiceId}:${NORM_VERSION}:${sha256(normalizedText)}`
    value: AudioCacheRecord
    indexes: { bookId: BookId; lastUsed: number }
  }
}

interface AudioCacheRecord {
  key: string            // denormalized for convenience
  blob: Blob             // WAV, 22050 Hz mono 16-bit (per Piper spike)
  bookId: BookId         // for per-book cascade clear
  sizeBytes: number      // for budget accounting (blob.size)
  synthMs: number        // diagnostics — original synth time
  voiceId: VoiceId       // for "clear entries for voice X" if ever needed
  lastUsed: number       // Date.now() at last hit/insert — LRU ordering
  createdAt: number
}
```

### `normalize.ts` (additive)

```ts
export const NORM_VERSION = '1'  // bump to invalidate the entire cache
```

### `types.ts` (additive)

```ts
export interface AudioCacheRecord { /* see schema above */ }
```

### `lib/tts/types.ts` (additive)

```ts
export interface SynthesisRequest {
  text: string
  voiceId: VoiceId
  /** Optional: book this paragraph belongs to, for per-book cache cascade. */
  bookId?: BookId
}
```

### New db helpers

```ts
/** Lookup a cached audio entry; bumps `lastUsed` on hit. Returns undefined on miss. */
function getAudioCacheEntry(key: string): Promise<AudioCacheRecord | undefined>

/** Insert/overwrite a cache entry; runs the LRU sweep if over budget.
 *  On QuotaExceededError, evicts half the cache and retries once. */
function putAudioCacheEntry(record: AudioCacheRecord): Promise<void>

/** Total bytes across all cache entries. */
function getAudioCacheSize(): Promise<number>

/** All keys for a book (for cascade delete). Uses the `bookId` index. */
function getAudioCacheKeysByBook(bookId: BookId): Promise<string[]>

/** Evict oldest entries by `lastUsed` until total ≤ budget. Returns count removed. */
function evictAudioCacheToBudget(budgetBytes: number): Promise<number>

/** Clear the entire audio cache. Returns count removed. */
function clearAudioCache(): Promise<number>
```

### Modified db helpers

```ts
/** deleteBookCascade — now also clears audioCache by bookId in the same tx. */
function deleteBookCascade(id: BookId): Promise<void>
```

### Unchanged

`TtsEngine`, `SynthesisResult`, `TtsRequest`/`TtsResponse` protocol (synth op gains an optional `bookId` field), `TtsClient`, `useParagraphPlayer`, `PlaybackStatus`, `PrerenderedChunk`. **No public API changes.**

## Architecture

```
/lib
  db.ts                  + audioCache store (v3); getAudioCacheEntry,
                           putAudioCacheEntry, getAudioCacheSize,
                           getAudioCacheKeysByBook, evictAudioCacheToBudget,
                           clearAudioCache; deleteBookCascade extended
  tts/
    normalize.ts         + export NORM_VERSION = '1'
    engine.ts            synthesize() — cache check before predict(), put on miss
    types.ts             + SynthesisRequest.bookId?
    protocol.ts          + optional bookId on synth op
    client.ts            threads bookId through
  storage.ts             (unchanged — persist() already requested)
  audio-cache.ts         NEW — sha256 key builder; thin wrappers over db helpers

/workers
  tts.worker.ts          threads bookId through to engine.synthesize

/hooks
  useParagraphPlayer.ts  (unchanged — tier 1 memory queue stays as-is)
  useAudioCacheStats.ts  NEW — polls getAudioCacheSize; powers the Settings indicator

/components
  AudioCacheIndicator.tsx  NEW — presentational: "412 MB / 500 MB" + Clear button
  OfflineBadge.tsx         (unchanged — sits next to this in Settings)

/routes
  settings.tsx           + "Storage" subsection mounting AudioCacheIndicator
```

### Synthesis flow (the only behavior change)

```
PiperEngine.synthesize(req):
  1. normalized = normalizeForSpeech(req.text)
  2. key = `${req.voiceId}:${NORM_VERSION}:${await sha256(normalized)}`
  3. hit = await getAudioCacheEntry(key)
  4. if hit: return { audio: hit.blob, synthMs: 0 }
  5. t0 = performance.now()
  6. audio = await session.predict(normalized)
  7. await putAudioCacheEntry({
       key, blob: audio, bookId: req.bookId, sizeBytes: audio.size,
       synthMs: performance.now() - t0, voiceId: req.voiceId,
       lastUsed: Date.now(), createdAt: Date.now(),
     })   // failures are non-fatal — audio is still returned to the caller
  8. return { audio, synthMs: performance.now() - t0 }
```

### Eviction

- **Sweep on write** — `putAudioCacheEntry` checks `getAudioCacheSize()` after the put; if > budget, calls `evictAudioCacheToBudget(500 * 1024 * 1024)` which opens a cursor on the `lastUsed` index and deletes oldest-first until under budget.
- **Quota safety net** — the put is wrapped in try/catch. On `QuotaExceededError`, evict half the cache by `lastUsed` and retry the put once. If it still fails, the synthesis still succeeds (the audio is returned to the caller; only the cache write is dropped).
- **No idle sweep, no periodic timer** — iOS Safari background makes both unreliable; reactive-on-write is sufficient because writes only happen on cache misses.

## Commands

Unchanged from M7:

```
pnpm install              # no new deps
pnpm dev                  # Vite dev server
pnpm build                # production build
pnpm typecheck            # tsc --noEmit
pnpm lint                 # biome check
pnpm test                 # vitest run
pnpm verify               # lint + typecheck + test + build
pnpm preview              # serve dist (use this + hard reload to verify SW/offline)
```

## Code style

Follows `.opencode/tech/typescript/patterns.md` + `react/patterns.md` and the M0–M7 conventions. Highlights:

- **Strict TS**, branded IDs, `import type` for type-only imports (`verbatimModuleSyntax`)
- **Container/presentational split** — `settings.tsx` is the container; `AudioCacheIndicator` is props-only
- **The `TtsEngine` contract is the seam** — the cache is an internal optimization of `PiperEngine`, invisible to the interface. The stub engine used in `useParagraphPlayer.test.ts` and `reader.test.tsx` keeps working unchanged.
- **No Context** for cache state — it's worker-internal + a single Settings read via `useAudioCacheStats`
- **Variant types** for async states (`{ type: 'loading' } | { type: 'ready'; sizeBytes }`)
- **Additive storage** — new store only; existing stores' records are untouched; `DB_VERSION` upgrade creates `audioCache` if absent
- **`crypto.subtle` in workers** — `sha256` runs in the worker via `crypto.subtle.digest('SHA-256', ...)`. Available in all target browsers (including Web Workers) per MDN. No Node polyfill needed.
- No comments unless asked; Biome handles format/import-order (2-space, single quotes, no semicolons, trailing commas)

## Testing strategy

- **DB** (`lib/db.test.ts`, extended): `audioCache` store created on v3 upgrade; `getAudioCacheEntry` round-trips and bumps `lastUsed` on hit; `putAudioCacheEntry` stores and `getAudioCacheSize` sums `sizeBytes`; `evictAudioCacheToBudget(500MB)` removes oldest-first by `lastUsed` and stops at budget; `clearAudioCache` empties the store; `deleteBookCascade` now removes the book + chapters + file + its audio cache entries in one transaction, leaving other books' cache entries untouched.
- **Hash + key** (`lib/audio-cache.test.ts`, new): same normalized text + voice → same key; different voice → different key; `NORM_VERSION` in key; raw text differing only in whitespace that `normalizeForSpeech` collapses → same key.
- **Engine** (`lib/tts/engine.test.ts`, extended): cache hit returns the same Blob and `synthMs: 0`; miss → `predict()` called once → `put` → second call hits; voice change → miss (different key); `NORM_VERSION` bump → all-miss; cache write failure (stubbed `put` rejection) → synthesis still returns audio.
- **Settings** (`routes/settings.test.tsx`, extended): `AudioCacheIndicator` renders "X MB / 500 MB"; Clear → calls `clearAudioCache` → renders "0 MB".
- **`useAudioCacheStats`** (`hooks/useAudioCacheStats.test.ts`, new): polls on mount; exposes a `refresh()` for manual re-query after Clear.
- **Player hook** (`hooks/useParagraphPlayer.test.ts`, **unchanged**): the stub `TtsEngine` returns a fresh Blob each call, exactly as today. Cache behavior is invisible to the player contract.
- **Browser** (chrome-devtools MCP): upload a book → play 5 paragraphs → note `synthMs` on each → reload → play the same 5 → `synthMs: 0` (cache hit) and audio starts within ~50 ms → switch voice → miss → switch back → hit → open Settings → cache size is non-zero → Clear → size is 0 → delete book from library → its cache entries gone (verify via DevTools → Application → IndexedDB). **Zero console errors.**
- **Coverage target:** new db helpers + `audio-cache.ts` + `useAudioCacheStats` + `AudioCacheIndicator` >90%; engine cache wiring smoke-tested.

## Boundaries

- **Always:** `pnpm typecheck && pnpm test && pnpm lint` green before considering a task done; define interfaces (`AudioCacheRecord`, db helper signatures, `NORM_VERSION`) before implementing; keep `TtsEngine` contract and worker protocol's existing ops unchanged; verify SW/offline via `pnpm preview` + hard reload.
- **Ask first:** adding dependencies; raising the budget beyond 500 MB; making the budget user-configurable; touching `normalizeForSpeech` logic (would require a `NORM_VERSION` bump).
- **Never:** disable strict TS; put cache state in Context; bake `playbackRate` into the cache key (it's live-applied on `<audio>`); hash raw text instead of normalized text; block synthesis on a cache write failure; change the `TtsEngine` interface.

## Success criteria (testable)

1. Playing paragraph N, reloading, and playing the same paragraph returns audio in <100 ms (cache hit), versus the original ~1 s warm / ~4 s cold.
2. Switching voice, then switching back to the original voice, produces cache hits on the original voice's entries (content-addressed correctness).
3. `deleteBookCascade` removes all of a book's audio cache entries in the same transaction; other books' entries survive.
4. Inserting entries beyond 500 MB triggers LRU eviction; total stays at or below 500 MB after writes settle.
5. A simulated `QuotaExceededError` evicts half the cache and retries; synthesis still succeeds.
6. Bumping `NORM_VERSION` invalidates the entire cache (all misses on next play).
7. Settings shows the current cache size and a Clear button; Clear empties the cache.
8. The stub `TtsEngine` in `useParagraphPlayer.test.ts` is unchanged (the cache is invisible to the contract).
9. `pnpm verify` (lint + typecheck + test + build) is green.
10. chrome-devtools MCP run: **zero console errors**; cache hit/miss, voice switch, clear, and book-delete cascade verified.

## Risks (tracked, not blocking)

| Risk | Mitigation |
| ---- | ---------- |
| **`crypto.subtle.sha256` unavailable** in some legacy context | Available in all target browsers + Web Workers per MDN; we already require WebAssembly + OPFS, which are stricter gates. If it ever fails at runtime, catch → skip cache (synthesis still works). |
| **IDB write latency on cache miss** adds latency to first play | The `put` is fire-and-await *after* `predict()` resolves and audio is returned to the caller — it does not block playback. Only the eviction sweep (rare, only when over budget) is synchronous to the put. |
| **Cache grows large on devices with many books** | 500 MB soft cap + LRU. Library shows total books; user can Clear. If a power user genuinely wants more, v2 can add a Settings slider. |
| **iOS ITP evicts the cache after 7 days of no interaction (gotcha #2)** | The cache is *recreatable* (re-synthesize on demand); the uploaded file is source of truth. Installed-to-home-screen PWAs are exempt from this eviction. Already documented; no new mitigation. |
| **DB_VERSION bump risks existing users on M5/M6/M7 builds** | Additive upgrade only — `audioCache` store is created if absent; existing stores untouched. `idb`'s `upgrade(db, oldVersion, newVersion)` callback branches on `oldVersion < 3`. Tested via a v2 → v3 migration test. |
| **Cache contains entries for a voice the user later removes** | Dead keys; LRU reaps them. Not a correctness issue. Optionally, `engine.remove(voiceId)` could clear that voice's entries — defer to a polish task. |
| **Service worker caches stale M8 bundle** | Existing gotcha #3: verify via `pnpm preview` + hard reload. |
| **Hashing 50 KB of text per synth call adds CPU cost** | SHA-256 of 50 KB is sub-millisecond on any modern phone; negligible vs. ~1 s Piper inference. If profiling disagrees, memoize the hash on the normalized string in the worker. |

## Tasks (ordered, dependency-chained)

| # | Task | Acceptance | Verify | Files |
| - | ---- | ---------- | ------ | ----- |
| T1 | Schema + db helpers | `DB_VERSION=3`; `audioCache` store with `bookId`+`lastUsed` indexes; 6 new helpers; `deleteBookCascade` extended; v2→v3 upgrade test | `lib/db.test.ts` (extended) | `lib/db.ts`, `types.ts`, `lib/db.test.ts` |
| T2 | Key + cache layer | `NORM_VERSION` exported; `sha256`-based key builder; key determinism tests | `lib/audio-cache.test.ts` (new) | `lib/tts/normalize.ts`, `lib/audio-cache.ts` (new), test |
| T3 | Engine integration | `PiperEngine.synthesize` checks cache before `predict()`, puts on miss, never blocks playback on write failure; `bookId` threaded via `SynthesisRequest.bookId?`; reader + worker updated to pass it | `lib/tts/engine.test.ts` (extended), `routes/reader.test.tsx` | `lib/tts/{engine,types}.ts`, `lib/tts/protocol.ts`, `workers/tts.worker.ts`, `routes/reader.tsx`, tests |
| T4 | Eviction + quota safety | `evictAudioCacheToBudget` removes oldest-first; sweep runs after each put > budget; `QuotaExceededError` → evict-half + retry once | `lib/db.test.ts` (extended) | `lib/db.ts`, test |
| T5 | Settings UX | `useAudioCacheStats` polls size; `AudioCacheIndicator` renders "X MB / 500 MB" + Clear; Clear empties | `hooks/useAudioCacheStats.test.ts`, `components/AudioCacheIndicator.test.tsx`, `routes/settings.test.tsx` | `hooks/useAudioCacheStats.ts`, `components/AudioCacheIndicator.tsx`, `routes/settings.tsx`, tests |
| T6 | E2E + browser verify | Cache hit/miss, voice switch, clear, cascade verified; zero console errors; `pnpm verify` green | full `pnpm verify` + chrome-devtools MCP | wiring + minor fixes |

**Ordering:** T1 → T2 → T3 → T4 → T5 → T6. (T4's eviction is implemented alongside T1's helpers but exercised end-to-end via T3's engine integration tests.)

**Checkpoints:** A (T1: schema shipped) · B (T2: key layer shipped) · C (T3: cache wired end-to-end) · D (T4: eviction verified) · E (T5: Settings shipped) · F (T6: M8 shipped, verify green).

## Out of scope (later passes)

- User-configurable budget (slider in Settings).
- Per-book cache breakdown in the library (e.g. "this book uses 78 MB of cache").
- Clearing a specific voice's cache entries when `engine.remove(voiceId)` runs.
- Pre-warming the cache (e.g. "render whole book overnight" / "render next chapter ahead").
- Cross-device sync (cloud is a non-goal per `VISION.md`).
- Moving the cache to OPFS for very-large blobs (chunks are ~300 KB; IDB is the right fit now).
- Caching AI-transformed text differently from cleaned text (transforms are already reflected in the paragraph text fed to `synthesize`, so they're naturally content-addressed).
