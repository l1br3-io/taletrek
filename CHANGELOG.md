# Changelog

Reverse-chronological history of what shipped. The current phase's spec lives at `SPEC.md`; shipped phases archive under `tasks/archive/<date>-<slug>/` (SPEC.md + plan.md + todo.md as a unit).

## M7 — Reader UX & Mobile · 2026-07-23
Responsive layout + nav drawer, chapter outline, minimized playback menu with overflow, go-to-current + FAB, auto-scroll to resumed paragraph on first Play.

## M8.1 — iOS Huge-Book Upload Resilience · 2026-07-18
Mobile encode cap (~200 MB) + upload resilience (wake lock, boot-sweep recovery). Verified on iPhone. ADR-0009. (`tasks/archive/2026-07-18-ios-upload-resilience/`)

## M10 — PDF Structure Extraction · 2026-07-18
PDF outline → chapters at upload (pdfjs); AI-only fallback. Pre-M10 heuristic detector removed (too many false positives). ADR-0008. (`tasks/archive/2026-07-18-pdf-structure/`)

## M6.1 — Biometric Key Caching · 2026-07-17
Opt-in WebAuthn PRF tier on top of M6's in-memory default; auto-falls-back where unsupported. ADR-0007 augments ADR-0004. (`tasks/archive/2026-07-17-biometric-key-caching/`)

## M12 — Parallel Synthesis · 2026-07-14
Bounded multi-worker pool for faster pre-synthesis. Mobile-safe (cap=2); reader and playback unchanged. ADR-0011. *(No standalone spec/plan — spec was inline; nothing archived.)*

## M8 — Audio Cache · 2026-07-13
On-device audio cache, LRU-bounded (~500 MB), per-book clear. Resume-after-reload near-instant. (`tasks/archive/2026-07-13-audio-cache/`)

## M6 — AI Transforms · 2026-07-13
Optional cleanup/translate/summarize/simplify using user's cloud key. Cloud-only after ADR-0005 (in-browser LLM backend removed). Per-paragraph transforms + pronunciation hints. ADR-0003, ADR-0004. (`tasks/archive/2026-07-13-ai-transforms/`)

## M5 — Library & Offline · 2026-07-12
Library view, resume-where-you-left-off, cached TTS models for true offline, polished installable PWA. (`tasks/archive/2026-07-12-library-offline/`)

## M4 — Clean Reading · 2026-07-12
Links/images/footnotes/page-numbers auto-skipped; configurable filters + pronunciation dictionary. (`tasks/archive/2026-07-12-clean-reading/`)

## M3 — Jog Mode · 2026-07-11
Pre-rendered audio chunks via `<audio>` + Media Session lock-screen controls. Background playback breakthrough. (`tasks/archive/2026-07-11-jog-mode/`)

## M2 — Speak · 2026-07-11
Piper TTS (WASM) — on-device neural synthesis; voice picker, speed, pause/resume, read-along. (`tasks/archive/2026-07-11-speak/`)

## M1 — Upload & Read · 2026-07-11
PDF/EPUB/MOBI/TXT ingest → clean reader view, stored in IndexedDB. (`tasks/archive/2026-07-11-upload-read/`)

## M0 — Foundation · 2026-07-11
PWA shell, IndexedDB persistence, Service Worker offline, landing/reader/settings. Piper spike thesis proven. (`tasks/archive/2026-07-11-foundation/`)

---

## In progress (not yet shipped)

- **M11 — Pluggable Playback Engines, Pausable Synthesis, Mobile Synth Lockdown** — native Web Audio engine default (no 30 MB download, no encode step); FFmpeg whole-book path as fallback. Pausable synthesis persisted via `book.uploadJob`. Mobile synth lockdown. ADR-0010 supersedes ADR-0006. Spec: `SPEC.md`.
- **M13 — Whole-Book Streaming AI Transform** — in-place streaming transforms; pause/resume/cancel; playback blocked while running. ADR-0012. Spec: `spec/m13-whole-book-streaming-transform.md` (parallel phase).

## Deferred

- **M9 — Mobile Streaming Playback** — deferred per ADR-0010; superseded for the common case by M11. Dormant scaffolding stays as the fallback path. (`tasks/archive/2026-07-16-mobile-streaming-deferred/`)
