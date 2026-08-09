# Changelog

Reverse-chronological history of what shipped. The current effort's spec lives at `docs/specs/<slug>/spec.md`; shipped efforts stay in place under `docs/specs/<slug>/` (the spec.md frontmatter flips to `status: shipped`).

## Off-device synth track · Tier 2 (SPA ↔ Desktop bundle exchange) · 2026-08-07

The optional, self-hostable companion track ([ADR-0013](docs/adrs/0013-off-device-synth-and-portable-bundles.md)) ships its first user-reachable capability: the closed loop **SPA export → `taletrek-desktop` synth → SPA import**. Books flow between the phone and a standalone Rust app as portable `.taletrek` files; the default offline-first PWA (on-device Piper) is unchanged. Three efforts landed in sequence:

- **Effort 1 — `portable-bundle-format`** (2026-08-03): frozen v1 `.taletrek` format + reusable Rust `crates/synth` crate (normalize, cache-key, `synthesize_paragraph`, Piper subprocess, Opus encode, bundle I/O). ([`docs/specs/portable-bundle-format/`](docs/specs/portable-bundle-format/))
- **Effort 2 — `desktop-synth-app`** (2026-08-04): `taletrek-desktop` headless CLI — `synth` (text-only → full bundle, parallel Piper) and `resynth` (whole-book voice swap), auto voice download from HuggingFace, stderr progress. ([`docs/specs/desktop-synth-app/`](docs/specs/desktop-synth-app/))
- **Effort 3 — `spa-bundle-import-export`** (2026-08-07): TS reader/writer for `.taletrek` in the SPA + library Import/Export UI; full bundles play immediately via content-addressed audio-cache dedup; parity-tested against the Rust fixtures. ([`docs/specs/spa-bundle-import-export/`](docs/specs/spa-bundle-import-export/))

Tiers now reachable: **(1)** SPA alone (existing) · **(2)** SPA + Desktop (this). Effort 4 (`personal-server`, Tier 3) remains.

## M7 — Reader UX & Mobile · 2026-07-23
Responsive layout + nav drawer, chapter outline, minimized playback menu with overflow, go-to-current + FAB, auto-scroll to resumed paragraph on first Play. ([`docs/specs/reader-ux-mobile/`](docs/specs/reader-ux-mobile/spec.md))

## M13 — Whole-Book Streaming AI Transform · 2026-07-20
Whole-book AI transforms stream in place — each chapter's paragraphs rewrite token-by-token in the reader as the model generates. Pause/resume/cancel mid-stream; playback blocked while running; resume survives tab close via `book.transformJob`. ADR-0012. ([`docs/specs/whole-book-streaming-transform/`](docs/specs/whole-book-streaming-transform/spec.md))

## M11 — Pluggable Playback Engines, Pausable Synthesis · 2026-07-19
Native Web Audio engine default (no 30 MB download, no encode step); FFmpeg whole-book path as fallback. Pausable synthesis persisted via `book.uploadJob`. Mobile synth lockdown. ADR-0010 supersedes ADR-0006. ([`docs/specs/playback-engines-pausable-synth/`](docs/specs/playback-engines-pausable-synth/spec.md))

## M8.1 — iOS Huge-Book Upload Resilience · 2026-07-18
Mobile encode cap (~200 MB) + upload resilience (wake lock, boot-sweep recovery). Verified on iPhone. ADR-0009. ([`docs/specs/ios-upload-resilience/`](docs/specs/ios-upload-resilience/spec.md))

## M10 — PDF Structure Extraction · 2026-07-18
PDF outline → chapters at upload (pdfjs); AI-only fallback. Pre-M10 heuristic detector removed (too many false positives). ADR-0008. ([`docs/specs/pdf-structure/`](docs/specs/pdf-structure/spec.md))

## M6.1 — Biometric Key Caching · 2026-07-17
Opt-in WebAuthn PRF tier on top of M6's in-memory default; auto-falls-back where unsupported. ADR-0007 augments ADR-0004. ([`docs/specs/biometric-key-caching/`](docs/specs/biometric-key-caching/spec.md))

## M12 — Parallel Synthesis · 2026-07-14
Bounded multi-worker pool for faster pre-synthesis. Mobile-safe (cap=2); reader and playback unchanged. ADR-0011. *(No standalone spec/plan — spec was inline; no `docs/specs/` entry.)*

## M8 — Audio Cache · 2026-07-13
On-device audio cache, LRU-bounded (~500 MB), per-book clear. Resume-after-reload near-instant. ([`docs/specs/audio-cache/`](docs/specs/audio-cache/spec.md))

## M6 — AI Transforms · 2026-07-13
Optional cleanup/translate/summarize/simplify using user's cloud key. Cloud-only after ADR-0005 (in-browser LLM backend removed). Per-paragraph transforms + pronunciation hints. ADR-0003, ADR-0004. ([`docs/specs/ai-transforms/`](docs/specs/ai-transforms/spec.md))

## M5 — Library & Offline · 2026-07-12
Library view, resume-where-you-left-off, cached TTS models for true offline, polished installable PWA. ([`docs/specs/library-offline/`](docs/specs/library-offline/spec.md))

## M4 — Clean Reading · 2026-07-12
Links/images/footnotes/page-numbers auto-skipped; configurable filters + pronunciation dictionary. ([`docs/specs/clean-reading/`](docs/specs/clean-reading/spec.md))

## M3 — Jog Mode · 2026-07-11
Pre-rendered audio chunks via `<audio>` + Media Session lock-screen controls. Background playback breakthrough. ([`docs/specs/jog-mode/`](docs/specs/jog-mode/spec.md))

## M2 — Speak · 2026-07-11
Piper TTS (WASM) — on-device neural synthesis; voice picker, speed, pause/resume, read-along. ([`docs/specs/speak/`](docs/specs/speak/spec.md))

## M1 — Upload & Read · 2026-07-11
PDF/EPUB/MOBI/TXT ingest → clean reader view, stored in IndexedDB. ([`docs/specs/upload-read/`](docs/specs/upload-read/spec.md))

## M0 — Foundation · 2026-07-11
PWA shell, IndexedDB persistence, Service Worker offline, landing/reader/settings. Piper spike thesis proven. ([`docs/specs/foundation/`](docs/specs/foundation/spec.md))

---

## Deferred

- **M9 — Mobile Streaming Playback** — deferred per ADR-0010; superseded for the common case by M11. Dormant scaffolding stays as the fallback path. ([`docs/specs/mobile-streaming-deferred/`](docs/specs/mobile-streaming-deferred/spec.md))
