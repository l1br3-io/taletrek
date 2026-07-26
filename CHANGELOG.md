# Changelog

Reverse-chronological history of what shipped. The current phase's spec lives at `SPEC.md`; shipped specs archive under `tasks/archive/<date>-<slug>/SPEC.md`.

## M12 — Parallel Synthesis · 2026-07-14
Bounded multi-worker pool for faster pre-synthesis. Mobile-safe (cap=2); reader and playback unchanged. (`tasks/archive/2026-07-14-parallel-synthesis/` — *no archived artifacts; spec was inline*)

## M8.1 — iOS Huge-Book Upload Resilience · 2026-07-18
Mobile encode cap (~200 MB) + upload resilience (wake lock, boot-sweep recovery). Verified on iPhone. ADR-0009.

## M10 — PDF Structure Extraction · 2026-07-18
PDF outline → chapters at upload (pdfjs); AI-only fallback. Pre-M10 heuristic detector removed (too many false positives). ADR-0008.

## M6.1 — Biometric Key Caching · 2026-07-17
Opt-in WebAuthn PRF tier on top of M6's in-memory default; auto-falls-back where unsupported. ADR-0007.

## M11 — Pluggable Playback Engines, Pausable Synthesis · 🚧 in progress
Native Web Audio engine default (no 30 MB download, no encode step); FFmpeg whole-book path as fallback. Pausable synthesis persisted via `book.uploadJob`. Mobile synth lockdown. ADR-0010 supersedes ADR-0006.

## M8 — Audio Cache · 2026-07-13
On-device audio cache, LRU-bounded (~500 MB), per-book clear. Resume-after-reload near-instant.

## M6 — AI Transforms · 2026-07-13
Optional cleanup/translate/summarize/simplify using user's cloud key. Cloud-only after ADR-0005 (in-browser LLM backend removed). Per-paragraph transforms + pronunciation hints. ADR-0003, ADR-0004.

## M5 — Library & Offline · 2026-07-12
Library view, resume-where-you-left-off, cached TTS models for true offline, polished installable PWA.

## M4 — Clean Reading · 2026-07-12
Links/images/footnotes/page-numbers auto-skipped; configurable filters + pronunciation dictionary.

## M3 — Jog Mode · 2026-07-11
Pre-rendered audio chunks via `<audio>` + Media Session lock-screen controls. Background playback breakthrough.

## M2 — Speak · 2026-07-11
Piper TTS (WASM) — on-device neural synthesis; voice picker, speed, pause/resume, read-along.

## M1 — Upload & Read · 2026-07-11
PDF/EPUB/MOBI/TXT ingest → clean reader view, stored in IndexedDB.

## M0 — Foundation · 2026-07-11
PWA shell, IndexedDB persistence, Service Worker offline, landing/reader/settings. Piper spike thesis proven.
