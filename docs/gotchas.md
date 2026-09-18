# Critical gotchas — full detail

> **When to read:** before touching the relevant area. The [`AGENTS.md`](../AGENTS.md) index lists the trap titles; this file holds the explanations. Load the specific entry on demand, not the whole file.

> **Native-pivot audit (2026-08-30, ADR-0015):** entries marked **RETIRED** describe
> features deleted from the SPA by the pivot — in-browser synth (Piper WASM), upload /
> parse workers, AI transforms, the crypto keyring, and the personal server are all gone.
> They are kept verbatim for historical context and for reading the old ADRs; do not
> apply them to new work. **IDs are stable** — retired entries and any gaps in numbering
> are intentional, never renumber. Entries without the marker were re-verified against
> the scoped-down SPA and are live.

<a id="g1"></a>
### 1. `onnxruntime-web` must be pinned to `1.18.0` — RETIRED (native pivot)

`@mintplex-labs/piper-tts-web` hardcodes the ORT wasm to cdnjs@1.18.0; any other JS version deadlocks inference silently. Mirror the wasm locally for M2 (see spike doc).

<a id="g2"></a>
### 2. Safari deletes script storage after 7 days of no interaction (ITP)

Design cached audio as re-hydratable; call `navigator.storage.persist()`. The imported `.taletrek` bundle is the source of truth — anything in IndexedDB/OPFS can be dropped and re-imported.

<a id="g3"></a>
### 3. Dev SW caches stale bundles

When verifying source changes in-browser, unregister the SW or test via `pnpm preview` (production build) + hard reload. The SW is app-shell precache only (`web/vite.config.ts`, `devOptions.enabled: true`) — it happily serves yesterday's build while you're staring at today's source.

<a id="g4"></a>
### 4. License: fully MIT

ADR-0002. The GPL option (ADR-0001) is fallback-only. Do not re-litigate unless the MIT package breaks.

<a id="g5"></a>
### 5. iOS lock-screen background playback is NOT yet verified on real hardware

The desktop MCP can't test it. Validate on a real iPhone before committing to any playback-behavior claim.

<a id="g6"></a>
### 6. Web Workers have no `DOMParser` — RETIRED (native pivot; parse workers deleted)

The EPUB parser runs inside the parse worker, so it uses `fast-xml-parser` (worker-safe), not the DOM. Any future parsing that needs a DOM must stay on the main thread or use a worker-safe parser. Unit tests can't catch this (jsdom has DOMParser) — only a real browser run does.

<a id="g7"></a>
### 7. `pdfjs-dist` is lazy-imported inside `parse()` — RETIRED (native pivot; PDF parsing deleted)

Importing it at module top-level pulls `DOMMatrix` at load, which crashes jsdom. Keep the dynamic `await import('pdfjs-dist')` in `pdf.ts`.

<a id="g8"></a>
### 8. Send file *bytes*, not the `File`, to a worker — RETIRED (native pivot; parse workers deleted)

`parseInWorker` reads `file.arrayBuffer()` on the main thread and transfers the `ArrayBuffer`; the worker reconstructs the `File`. Cloning a `File` across the worker boundary can fail for files backed by a filesystem path.

<a id="g9"></a>
### 9. WebGPU is no longer used — RETIRED (native pivot; AI transforms deleted)

The on-device WebLLM backend was removed (ADR-0005); AI transforms are cloud-only now. The old `requestAdapter()` feature-detect / Flatpak-Vulkan guidance no longer applies.

<a id="g10"></a>
### 10. iOS Safari MSE is `<video>`-only

(ADR-0006 / M9) `MediaSource` + `SourceBuffer` work on `<video>` elements but **not** on `<audio>`. This is why the `<video>`-based playback path (the FFmpeg engine's hidden `display: none` element, plus its `canPlayType('audio/mp4; codecs="mp4a.40.2"')` probe in `lib/playback/engines.ts`) standardizes on `<video>`. The MSE streaming engine itself never shipped and its scaffolding was deleted in the pivot — the underlying Safari fact is kept for any future MSE work.

<a id="g11"></a>
### 11. FFmpeg WASM core is ~30 MB and single-threaded

(ADR-0006 / M9) The `@ffmpeg/core` WASM is downloaded to OPFS on first use, then loaded from OPFS on subsequent uses. **Do not** use the multi-threaded core (`@ffmpeg/core-mt`) — it requires `SharedArrayBuffer` which forces cross-origin isolation (COOP/COEP) headers on the entire app. Single-threaded is fast enough for encoding short speech clips.

<a id="g12"></a>
### 12. `SourceBuffer.appendBuffer` is async — no overlapping appends

*(Dormant — no MSE/`SourceBuffer` usage survives the pivot; retained as browser-fact reference.)* Wait for the `updateend` event before calling `appendBuffer` again. Use `SourceBuffer.timestampOffset` to position each segment at the correct time in the timeline. Read cumulative duration from `sourceBuffer.buffered.end(ranges.length - 1)` after each append.

<a id="g13"></a>
### 13. `<video>` elements pause on iOS lock screen

(ADR-0006 / M9) This is an accepted limitation of the `<video>`-based FFmpeg engine — the Web Audio engine accepts the same trade (ADR-0010). The user taps play to resume from their position. Do not attempt workarounds — the per-paragraph `<audio>` approach (desktop) fails entirely on lock, which is worse.

<a id="g14"></a>
### 14. WebAuthn PRF cannot be unit-tested in jsdom — RETIRED (native pivot; keyring deleted)

(ADR-0007 / M6.1) `secure-keyring.test.ts` mocks `crypto/prf` to control the biometric flow; the AES round-trip + IDB persistence run for real. Real-device verification requires a browser + authenticator that supports the PRF extension (Chrome/Edge yes, Safari 18+, Firefox partial; platform authenticators like Touch ID / Windows Hello work, as do FIDO2 security keys like YubiKey). The `BiometricKeyringSection` returns `null` on unsupported browsers — that fallback is the contract, not a bug. Don't add a master-passphrase fallback tier; ADR-0007 explicitly rejected it as weaker than PRF-where-supported + silent-fallback-to-in-memory.

<a id="g15"></a>
### 15. `crypto.subtle` is a built-in browser API, not a network call — RETIRED (native pivot; keyring deleted)

(ADR-0007 / M6.1) The existing CSP `connect-src` allowlist doesn't need to be touched for AES-GCM or WebAuthn — neither makes a fetch. CSP remains the primary exfiltration defence for an *unlocked* key; PRF is defense-in-depth for the *at-rest* blob only.

<a id="g16"></a>
### 16. The wrapped-DEK pattern is load-bearing — RETIRED (native pivot; keyring deleted)

(ADR-0007 / M6.1) `secure-keyring.ts` deliberately wraps a random DEK with a PRF-derived KEK rather than using the PRF output as the encryption key directly. Per Tim Cappalli (W3C WebAuthn L3 co-editor), passkey rotation invalidates PRF output — wrapping a DEK we control means re-enrolling with a new passkey can re-wrap the same DEK without re-encrypting the keys blob. Don't "simplify" this to PRF-output-as-key.

<a id="g17"></a>
### 17. PDF outline = pdfjs only; AI is the only fallback — RETIRED (native pivot; PDF parsing deleted)

(ADR-0008 / M10) Tier 1 (`doc.getOutline()`) runs automatically on every PDF upload; unstructured PDFs and non-PDF formats require AI (`useOutline.runWithAi`). **Do not reintroduce a regex/font-size heuristic** — the old `lib/outline/detect.ts` was deleted (ADR-0008) as too false-positive-prone on real fiction. Outline nav depends on capturing the **Y coord** from pdfjs dest arrays so mid-page chapter starts don't bleed into the wrong chapter; a leading body paragraph matching the chapter title is stripped.

<a id="g18"></a>
### 18. Screen wake lock during upload is best-effort and never throws — RETIRED (native pivot; upload deleted)

(ADR-0009, **revised 2026-07-19**) `acquireUploadWakeLock()` always resolves to a no-op-capable handle; Safari < 16.4 has no Wake Lock API → silent fallback. **Do not make `request()` failure fatal.** Companion: `reconcileInterruptedUploads()` runs in `main.tsx` **before** `createRoot().render()` (avoids a race with stale-id navigation). **Revised recovery rule:** `uploading === true` at boot = interrupted session — if audio exists, clear the flag; **otherwise convert to paused** (`uploading = false`, keep `uploadJob`). **Never cascade-delete** — parsed chapters and partial synth are real investment; the book surfaces as Paused with a Resume button. `runJob` writes `uploadJob` from the first tick and bumps `done`/`lastFlatIndex`/etc per-¶. **Resume is user-initiated** (library → tap Resume); auto-resume-on-boot and boot prompts were explicitly rejected.

<a id="g19"></a>
### 19. Worker error boundaries preserve DOMException identity — RETIRED (native pivot; TTS/concat workers deleted)

The TTS and concat workers post `{ name, code, message }` on failure; the main-thread clients reconstruct a real `DOMException` when a name is present, and they reject all pending requests if the worker fires an `error`/`messageerror`. Never rely on `error.message` alone across the worker boundary — name/code are needed to distinguish quota/readable/OOM errors.

<a id="g20"></a>
### 20. Mobile whole-book encode has a hard cap — RETIRED (native pivot; encode pipeline deleted)

Before `encodeBook`, the upload manager estimates the final m4a size from the accumulated paragraph durations (64 kbps AAC). If it exceeds `MAX_MOBILE_M4A_BYTES` (~200 MB ≈ 7h of speech), the encode is skipped, the book uploads successfully, and `usePlayer` falls back to the desktop per-paragraph engine on mobile. Lock-screen playback pauses between paragraphs for those books until M9 streaming removes the cap.

<a id="g21"></a>
### 21. Active upload jobs pin their book's audio-cache entries — RETIRED (native pivot; upload deleted)

`setPinnedAudioCacheBookId` skips pinned records in `evictAudioCacheToBudget` and `evictAudioCacheFraction` so a long book's own paragraphs aren't evicted mid-synthesis. The pin is cleared in `manager.runJob`'s `finally`.

<a id="g22"></a>
### 22. Pluggable playback engines — Web Audio default, FFmpeg fallback

(ADR-0010 / M11) `resolveMobileEngine(settings.playbackEngine, MOBILE_ENGINES)` picks the engine: `'auto'` → **Web Audio (native)** if `AudioContext` exists, else FFmpeg. `usePlayer` is the one remaining consumer — it picks `useWebAudioPlayer` vs `usePreloadedPlayer`. The Web Audio engine performs **no** encode — it decodes+schedules cached WAVs from the audio cache. **Since the pivot the SPA cannot re-synth:** a cache miss surfaces an explicit error (the `TtsEngine` seam is an `unavailableEngine` stub) — bundles must arrive fully synthesized. ADR-0010 supersedes ADR-0006's Web Audio rejection on lock-suspend → tap-resume parity with the `<video>` path (gotcha #13). Real-device verification passed on iPhone before the Web Audio default shipped.

<a id="g23"></a>
### 23. Web Audio scheduler: `setInterval` not rAF; suspend/resume = pause/play; re-anchor on seek + rate change

(ADR-0010 / M11) Paragraphs chain via `source.start(scheduledEnd)` — **zero JS at paragraph boundaries** (what makes iOS lock-suspend benign: `ctx.currentTime` just freezes). The advance loop runs on `setInterval(~250 ms)`, **never `requestAnimationFrame`** — rAF throttles to ~1 Hz hidden; `setInterval` keeps highlight tracking + ≥3 ¶s scheduled ahead so a throttled tick never starves playback. Pause = `ctx.suspend()`; play = `ctx.resume()`; iOS `'interrupted'` handled via `statechange`. Seek and rate change **re-anchor**: stop future sources, reschedule from target at `start(when, offset)`, apply new `playbackRate` — **never mutate `playbackRate` on scheduled sources** (desyncs the offset table). The scheduler is a pure, mock-`AudioContext`-testable module; `useWebAudioPlayer` returns the existing `UseParagraphPlayerResult` so UI/Media Session are engine-agnostic.

<a id="g24"></a>
### 24. Pausable synthesis persists via `book.uploadJob` with `uploading = false` — RETIRED (native pivot; upload deleted)

(ADR-0010 / M11) `uploadManager` gains a `'paused'` `JobState`; `pause()` is a cooperative abort at the next ¶ boundary (existing `AbortController`), then persists `book.uploadJob` and sets `uploading = false`. **Load-bearing:** a paused book has `uploading = false`, so it's invisible to `reconcileInterruptedUploads` (gotcha #18 / ADR-0009) — only explicit user pause becomes resumable; true interruptions still convert. Auto-resume-on-boot stays out of scope. `resume(bookId)` reloads chapters, re-runs the persisted spec (consistent audio set even if global settings changed), and the M8 cache fast-forwards. No DB version bump — `uploadJob` is a new optional field on `Book` (IDB schemaless). Don't "fix" the boot sweep to touch paused books; don't add auto-resume-on-boot (both rejected in ADR-0009).

<a id="g25"></a>
### 25. Parallel synthesis via `PoolEngine` — pre-synth only, lazy spin-up, mobile cap = 2 — RETIRED (native pivot; in-browser synth deleted)

(ADR-0011 / M12, ✅ verified 2026-07-19 on iPhone + desktop) `PoolEngine` (`lib/tts/pool.ts`) spawns N workers (mobile = 2, desktop = `min(navigator.hardwareConcurrency, 8)` per `lib/tts/pool-size.ts`), dispatches `synthesize` least-busy, re-spawns fatal-error workers (`NotFoundError`/`InvalidStateError`/`DataError`/`InternalError` — same allowlist as `client.ts`). Voice management still goes through the singleton — pool workers lazy-load from OPFS. **Reader/playback unchanged** — still singleton `ttsClient`. `preSynthesizeBook` takes `concurrency` (default `1` = sequential backward compat); the manager passes `pool.concurrency`. **`onProgress` gained a 3rd arg `completed?: ParagraphLocation`** — under `concurrency > 1` completion is out-of-order (peek-current heuristic deleted; pass `completed` directly). `paragraphs[i]` in the result is **flat-indexed** — pre-allocated, assigned by index on completion; `done` is monotonic (JS single-threaded). **Resume contract preserved** — `lastFlatIndex`/etc are UI-display-only (`types.ts:54-55`); the M8 cache is content-addressed so any completed ¶ fast-forwards. **iOS OOM cap = 2 is load-bearing** (verified on real iPhone). Don't add COOP/COEP for ORT pthreads (breaks any-static-host); don't widen the pool to reader/playback.

<a id="g26"></a>
### 26. Whole-book streaming AI transform — in-place streaming, resume mirrors `uploadJob`, playback blocked — RETIRED (native pivot; AI transforms deleted)

(ADR-0012 / M13, **revised 2026-07-20**) `bookTransformManager` drives op × chapter × chunk with the same SSE `engine.transform` contract M6 introduced. **In-place visual** (`ReaderView.streamingParagraphView`): **preserve mode** (non-reductive) — slot-by-slot replacement, cursor on in-progress slot, old text dimmed beyond; **replace mode** (reductive) — old ¶s vanish, new grow with cursor on last. **Singleton + `useBookTransformState()`** (`useSyncExternalStore`) survives navigation. **Resume mirrors gotcha #24:** paused has `transforming = false` → `reconcileInterruptedTransforms` ignores explicit pauses; only true interruptions convert. **Never cascade-delete;** cancel keeps committed ¶s. **Resume is chapter-level** (chunks commit at boundary); M8 cache fast-forwards. **Playback blocked while `transformJob` exists** (any state — reader gates Play on `!book.transforming && !book.transformJob`). **State emit is `setTimeout(250ms)`-throttled** (~4/sec; rAF stalls hidden — gotcha #23 cousin). **Reasoning models** emit `delta.reasoning_content`/`delta.reasoning` before visible output — `sse.ts` extracts both, the preparing chip shows live reasoning. **Chunk cap** (`UX_MAX_CHUNK_TOKENS = 2000`) keeps prefill fast. **`uploading === true` blocks `start()`.** Don't reintroduce `<StreamingChunkBlock>` (deleted — looked "stuck"); don't add concurrent per-¶ synth (rejected in ADR-0012); don't auto-resume on boot.

<a id="g27"></a>
### 27. Bundle import loads the whole archive into memory (jszip)

(Effort 3 / `spa-bundle-import-export`, resolved decision #4; ADR-0013) `reader.ts` reads a `.taletrek` via jszip, which buffers the entire ZIP — manifest, `text.json`, and every `audio/` blob — into memory before the importer writes anything to IDB. A huge full bundle (many hours of Opus) can pressure mobile RAM. v1 accepts this deliberately: it mirrors `backup.ts`'s in-memory approach (simplest correct impl) and the alternative (a streaming ZIP reader) is real complexity for a path that is, by design, the *off-device* relief valve. **The pre-flight `BundleTooLargeError` quota guard (resolved decision #3, `import.ts::assertQuotaForBundle`) catches IDB quota, not RAM — do not assume it protects against OOM.** A streaming reader is the documented follow-on if real-device testing shows memory pressure bites.

<a id="g28"></a>
### 28. Bundle `sourceFormat: "unknown"` maps to `'txt'` on SPA import

(Effort 3 / `spa-bundle-import-export`; see `import.ts::sourceFormatToBookFormat`) `bundle-format.md` permits `sourceFormat: "unknown"` (a desktop synth may not know the original file type); the SPA's `BookFormat` union has no `"unknown"` variant. Import collapses `"unknown"` → `'txt'` — the least-lossy default (plain text is the lowest-common-denominator the reader can always display; playback + re-synth are unaffected). The side effect is that a round-trip `epub → unknown → txt` is lossy on the *format label* only — the text itself was already cleaned upstream, so the reader and synth are unaffected. If a future feature ever cares about the original label, widen `BookFormat` rather than re-deriving it from file sniffing. Since kernel-parse, `html` and `docx` are producer-known values that map through import unchanged — only pre-pivot bundles carry `unknown`.

<a id="g29"></a>
### 29. Hosted-SPA CSP: document-only headers, Google Fonts blocked by the build's own policy, PWA manifest behind cookie auth — RETIRED (native pivot; personal server deleted)

(Effort 5 / T8, ✅ verified 2026-08-26 in Chrome 151) Three coupled findings when the personal server hosts the SPA at `/`:

1. **Never stamp a CSP on the SPA's non-HTML responses.** A CSP header on a *worker script* response becomes that worker's own policy — `script-src 'self'` there would block WASM compilation (Piper/ORT need `'wasm-unsafe-eval'`) and the ffmpeg core's `blob:` `importScripts`. The standalone hosting model never puts CSP on assets (the build's meta-tag CSP doesn't propagate into workers), and the server mirrors exactly that: `SPA_CSP` (`server/src/http/spa.rs`) is stamped only on `text/html` responses; assets stay policy-free.
2. **The Google Fonts `<link>` in `web/index.html` is already dead in production** — the build's own meta CSP (`style-src 'self' 'unsafe-inline'`, ADR-0004) blocks `fonts.googleapis.com`, and the UI silently falls back to the local mono stack (`'Fira Code', ui-monospace, …`). It logs the same console violation on the standalone `vite preview` — pre-existing, not a server regression. Don't "fix" it by widening the CSP (that would diverge hosted from standalone); either self-host the font or drop the link (T17 audit).
3. **PWA installability checks can't get past cookie auth** — Chrome's installability pipeline fetches `manifest.webmanifest` without credentials, gets the `303 → /ui/login` HTML, and logs `Manifest: Line: 1 … Syntax error` on first boot. The page-context manifest fetch (with cookies) succeeds; the app boots and runs fine. Hosted-mode install is inherently limited while the manifest is auth-gated — acceptable for the Jellyfin-style self-host; revisit only if hosted install matters.

<a id="g30"></a>
### 30. Clean-idempotence is a cross-app invariant — parse output must survive the reader's `cleanChapters` unchanged

(kernel-parse, "clean-at-parse" locked decision) `crates/parse` applies the M4 structural filters at parse time, so bundle paragraphs are canonical clean text. The web reader re-derives cleaning on every playback (`cleanChapters` under `DEFAULT_CLEANING`) — whatever those TS filters do to a parse-produced paragraph must leave it **byte-identical**, or the reader's text no longer matches the cache key the audio was synthesized under and playback dies on a cache miss (the explicit G22 error — post-pivot there is no re-synth to paper over it). Breaking the invariant orphans every already-synth'd bundle's audio. It is pinned from both sides: Rust (`clean_book(parse(x)) == parse(x)`; `crates/parse/src/clean.rs` module docs are the inline home) and TS (`web/src/lib/bundle/parse-parity.test.ts` imports a real parse-produced fixture through the full reader path and asserts the identity). Any edit to either filter set must keep them byte-faithful twins: same patterns, same application order.

<a id="g31"></a>
### 31. CDN-dependent instrumented tests need an emulator booted with `-dns-server`

(android-export-search, ExportTest session) The headless AVD on this host sometimes boots with an empty resolver — raw IPs ping (`adb shell ping 8.8.8.8` ✓) but every hostname lookup fails (`failed to lookup address information: No address associated with hostname`), so every suite that downloads the voice/espeak from the CDN (FirstRunTest, HardeningTest's warmups, PerfDatapointsTest, ExportTest) fails with `Failed(kind=resolve…)`. The trap: it looks like a code/CDN failure, and it's *intermittent* — some boots resolve fine. Boot the emulator with an explicit resolver: `emulator -avd taletrek … -dns-server 8.8.8.8,1.1.1.1` (the justfile's `_android-serve` doesn't pass one; the AVD's `net.dns*` props stay empty). Diagnose in one line: `adb shell ping -c1 huggingface.co` — "unknown host" means this gotcha.

<a id="g32"></a>
### 32. `just android-test` does not compile `androidTest/` — a UniFFI regen can silently break the instrumented suites

(progressive-synth, task 011 session) The JVM gate runs `testDebugUnitTest ktlintCheck` — the `androidTest/` source set is never compiled by it, and nothing else compiles it until `connectedDebugAndroidTest`. A checked-in Kotlin bindings regen that changes a data-class constructor (e.g. `FfiPipelineOutcome` gaining `sealed`) breaks every direct construction in `androidTest/` fixtures **silently** — `just android-test` stays green while the on-device suites can't build. This sat undetected from task 008 to task 011 (the outline-tap matcher rot also hid behind it). After any `just android-bindings` (or any FFI record/enum change), run `android/gradlew --project-dir android compileDebugAndroidTestKotlin` — or the next instrumented run — before believing the gates.

<a id="g33"></a>
### 33. The kernel `.so` is a prebuilt jniLib — gradle never rebuilds it, and a stale one fails as `undefined symbol` on device

(progressive-synth, task 011 session) `android/app/src/main/jniLibs/` holds prebuilt `.so` files that only `just android-kernel` refreshes (cargo-ndk for arm64-v8a + x86_64); every gradle task — including `connectedDebugAndroidTest` — packages them as-is. After any change to `crates/ffi` (new export, signature change), the emulator/device still runs the OLD kernel until `just android-kernel` runs. The failure shape is the trap: the app installs and old paths work, then dies with `UnsatisfiedLinkError: … uniffi_taletrek_ffi_fn_func_<new_fn>: undefined symbol` — which reads like a bindings mismatch, not a stale binary. Rule: FFI Rust change → `just android-kernel` → then any on-device run. (The `.so` files are gitignored; CI builds them fresh, so only local/CI-divergent checkouts bite.)
