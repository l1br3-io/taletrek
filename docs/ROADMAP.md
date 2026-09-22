# Roadmap

> Directional overview — no dates, no calendar. The *what's next*, not the spec.
> **Next effort:** `ios-app` — effort 5 of the native track (below); efforts 1–4.8 (`native-pivot`, `kernel-parse`, `desktop-synth-gui`, `desktop-ux-refresh`, `desktop-reader-page`, `android-app`, `android-pipeline`, `android-instant-listen`, `android-hardening`, `progressive-synth`) are shipped. The decisions: [ADR-0015](./adrs/0015-native-pivot-rust-kernel-and-native-apps.md) (the pivot), [ADR-0016](./adrs/0016-on-device-pipeline-android.md) (on-device pipeline). The why + locked stack: [`ideas/native-pivot.md`](./ideas/native-pivot.md).
> Companion: [`VISION.md`](./VISION.md) — the problem and goals.

TaleTrek is a free, open-source **reading companion**: turn any ebook or document into an audiobook using an OSS neural TTS engine (sherpa-onnx — Piper + Kokoro voices) running in-process in a Rust kernel. It strips links, images, and footnotes so only the story flows, then plays it as background audio that survives screen lock, app switching, and phone closure. You go for a run; your book comes with you. Free app-store downloads, no subscription, no cloud — one kernel, three native apps, and a web landing page + `.taletrek` reader.

The track's scope is **locked to the read-aloud core**: parse, clean, synth, and play in the background. Everything else is deferred.

---

## How we plan

### Scope decomposes top-down

```text
VISION   "What problem are we solving?"   docs/VISION.md
  │
ROADMAP  "What directions / milestones?"  docs/ROADMAP.md  (this)
  │
SPEC     "Current effort requirements"    docs/specs/<effort-slug>/spec.md
```

### Each effort ships through the harness lifecycle

```text
DEFINE → /spec       spec-driven-development             → docs/specs/<slug>/spec.md (status: draft)
PLAN   → /planning   planning-and-task-breakdown         → docs/specs/<slug>/{plan.md, todo.md, tasks/00N-*.md}
BUILD  → /build      incremental-implementation + TDD    → source + tests (flips spec status: draft → active)
VERIFY → /test       debugging-and-error-recovery        → pnpm verify green
REVIEW → /review     code-review-and-quality             → sign-off
SHIP   → /ship       shipping-and-launch                 → merge PR; spec status flips to shipped (dir stays in place)
```

When an effort ships, its spec.md frontmatter flips to `status: shipped`
with the merge date. The directory stays at `docs/specs/<slug>/` forever —
no archive step, no move. Git is the full history; the filesystem is the
browsable index. The next effort starts on a fresh branch with a fresh
`docs/specs/<new-slug>/` directory.

---

## Themes

| Theme | What it means |
|-------|---------------|
| **Ingest** | Accept any common ebook/document format and extract clean, readable text in `crates/parse` — the pipeline starts here |
| **Speak** | In-process neural TTS via sherpa-onnx (Piper + Kokoro voices) with voice choice and speed control — no cloud, no cost |
| **Jog** | Background-safe playback through native audio sessions (Media3 / AVFoundation) — the hands-free experience that defines the product |
| **Clean** | Strip links, images, footnotes, and noise — only the story flows through the speaker |

---

## Active track — Native pivot: Rust kernel + platform-native apps (ADR-0015)

One kernel (`crates/parse` + `crates/synth` + `crates/reader` + `crates/worker`) exposed via **UniFFI** to thin platform-native apps; `.taletrek` v1 bundles are the sole interchange; the web is a landing page + reader. Ship order: desktop synth processor → Android → iOS, free downloads on the stores. See [ADR-0015](./adrs/0015-native-pivot-rust-kernel-and-native-apps.md) and [`ideas/native-pivot.md`](./ideas/native-pivot.md).

Efforts, dependency-aware:

| # | Effort | State |
| --- | --- | --- |
| 1 | `native-pivot` — purge + re-foundation: ADR-0015, server deletion, SPA scoped down to reader + landing, docs rewrite, landing v1 | ✅ shipped ([spec](./specs/native-pivot/spec.md)) |
| 2 | `kernel-parse` — `crates/parse` (EPUB/TXT/HTML/MD/DOCX/PDF; MOBI open) + CLI file→bundle — closes the interim no-producer gap | ✅ shipped ([spec](./specs/kernel-parse/spec.md)) |
| 3 | `desktop-synth-gui` — the processor app: in-process sherpa-onnx TTS + native Opus encode behind the existing traits, egui GUI + unchanged CLI, release workflow | ✅ shipped ([spec](./specs/desktop-synth-gui/spec.md)) |
| 3.5 | `desktop-ux-refresh` — identity pass on the processor: web-pinned two-theme tokens, embedded mono+serif fonts, panel layout, dark/sepia toggle | ✅ shipped ([spec](./specs/desktop-ux-refresh/spec.md)) |
| 3.6 | `desktop-reader-page` — the read-back loop: `crates/reader` kernel core (BookIndex + PlayerState + Position) + in-app reader screen with paragraph-synced cpal/symphonia playback and position restore | ✅ shipped ([spec](./specs/desktop-reader-page/spec.md)) |
| 4 | `android-app` — Jetpack Compose + Media3 player; kernel via UniFFI; free Play Store download | ✅ shipped ([spec](./specs/android-app/spec.md)) |
| 4.5 | `android-pipeline` — files in, audio out, on the phone: `crates/worker::pipeline` (cancellable PipelineJob, deterministic ids) + FFI pipeline/voices surface + SynthService/import flow/voice catalog ([ADR-0016](./adrs/0016-on-device-pipeline-android.md)) | ✅ shipped ([spec](./specs/android-pipeline/spec.md)) |
| 4.6 | `android-instant-listen` — first-run production fix + zero decisions: the pipeline ensures espeak-ng-data in-job; picking/sharing a document submits the full audio job immediately (no gate dialog, no text-only mode, no voice prerequisite); `FirstRunTest` owns fresh-install → convert → play | ✅ shipped ([spec](./specs/android-instant-listen/spec.md)) |
| 4.7 | `android-hardening` — the platform-contract gaps + locked outline parity: `AUDIO_BECOMING_NOISY` → kernel `userPause` (playing-gated receiver, no auto-resume), the stale builder comment fixed, the locked reader-page outline design on Android (numbered rows, "Now reading" marker, "Chapter *n* of *N*" header, pre-scroll); hardware datapoints device-gated/owed | ✅ shipped ([spec](./specs/android-hardening/spec.md)) |
| 4.8 | `progressive-synth` — books that play before they finish: phase-1 scheduling wins (sentence-chunk tasks + LPT + shared runner pool + dedup pre-pass, −7–10% makespan) + segment store + `PipelineVariant::Progressive` (text bundle lands now, store fills horizon-first at the playhead, drain seals a standard `.taletrek`) + resume/skip-existing + anchor reprioritization; Android imports go progressive with play-while-filling (buffering, resume affordance, relaunch-resume) — time-to-first-listen ≤ 30 s replaces whole-book wall time as the product goal | ✅ shipped ([spec](./specs/progressive-synth/spec.md)) |
| 5 | `ios-app` — SwiftUI + AVFoundation; consumes the same `crates/ffi` surface (read + pipeline) unchanged; free App Store download ($99/yr accepted) | planned |

**Interim gap — closed by `kernel-parse`:** before effort 2, nothing converted ebooks into bundles (the desktop CLI was bundle→bundle and the web reader only opened existing `.taletrek` files). Since effort 2, `taletrek-desktop parse --input <doc>` (or the chained `synth --input <doc>`) turns EPUB/TXT/HTML/MD/DOCX/PDF sources into bundles.

---

## Milestone history

The read-aloud core shipped as an offline-first PWA (2026-03 → 2026-08), then ADR-0015 pivoted the product onto the native track above — carrying the `.taletrek` format, the Rust synth crates, and the reader forward.

| # | Milestone | State |
|---|-----------|-------|
| M0 | Foundation | ✅ shipped |
| M1 | Upload & Read | ✅ shipped |
| M2 | Speak | ✅ shipped |
| M3 | Jog Mode | ✅ shipped |
| M4 | Clean Reading | ✅ shipped |
| M5 | Library & Offline | ✅ shipped |
| M6 | AI Transforms | ✅ shipped (purged from the web by ADR-0015; may return as a desktop-processor feature) |
| M6.1 | Biometric Key Caching | ✅ shipped (deleted with the SPA upload pipeline, ADR-0015) |
| M7 | Reader UX & Mobile | ✅ shipped |
| M8 | Audio Cache | ✅ shipped |
| M8.1 | iOS Huge-Book Upload Resilience | ✅ shipped (upload pipeline deleted, ADR-0015) |
| M9 | Mobile Streaming Playback | ⏸ never shipped; scaffolding deleted ([ADR-0010](./adrs/0010-playback-engine-architecture.md)) |
| M10 | PDF Structure Extraction | ✅ shipped ([ADR-0008](./adrs/0008-pdf-structure-extraction.md); SPA parsing deleted, ADR-0015 — structure extraction returns in `crates/parse`) |
| M11 | Pluggable Playback Engines, Pausable Synthesis | ✅ shipped ([ADR-0010](./adrs/0010-playback-engine-architecture.md)) |
| M12 | Parallel Synthesis | ✅ shipped ([ADR-0011](./adrs/0011-parallel-synthesis-pool.md); in-browser pool deleted — the rayon pool in `crates/worker` is its heir) |
| M13 | Whole-Book Streaming Transform | ✅ shipped ([ADR-0012](./adrs/0012-whole-book-streaming-transform.md); transforms purged, ADR-0015) |

The off-device synth track ([ADR-0013](./adrs/0013-off-device-synth-and-portable-bundles.md)) shipped five efforts 2026-08-03 → 2026-08-29: `portable-bundle-format`, `desktop-synth-app`, `spa-bundle-import-export`, `personal-server`, `server-hosted-spa`. ADR-0015 narrowed it — the bundle format, desktop synth, and SPA bundle import/export survive as the native track's foundation; the personal-server tier was purged. **Specs of purged efforts were deleted from `docs/specs/` (ADR-0015); specs of surviving behavior remain** — playback engines, bundle import/export, library, reader UX, audio cache, clean reading. Ship history: [`CHANGELOG.md`](../CHANGELOG.md). ADRs live in [`docs/adrs/`](./adrs/); runtime gotchas in [`docs/gotchas.md`](./gotchas.md) (17 of 29 retired in place by the pivot).

---

## Future directions *(not current priorities)*

- **Reading intelligence** — bookmark syncing, skip-by-paragraph/chapter, sleep timers.
- **On-device mobile synthesis** — phones synth their own books, once the kernel is proven.
- **AI transforms on the desktop processor** — the purged transforms return where re-synth lives.
- **Platform & ecosystem** — browser extension, CarPlay/Bluetooth casting.
- **Advanced voices** — additional open-source voice models (custom voice training, multilingual books) via sherpa-onnx.
- **Accessibility** — high-contrast themes, dyslexia-friendly fonts, screen-reader-optimized navigation.
