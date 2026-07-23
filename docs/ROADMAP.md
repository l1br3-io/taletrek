# Roadmap

> **Status:** Directional overview — no dates, no calendar. Business-level; no technical detail.
> **Companion:** [`VISION.md`](./VISION.md) — the problem and goals. This roadmap does not duplicate requirements; it communicates direction and sequencing.

TaleTrek is a free, open-source **reading companion**: upload any ebook — PDF, EPUB, MOBI, or TXT — and TaleTrek reads it aloud using on-device text-to-speech. It strips out links, images, and footnotes so only the story flows, then plays it as background audio that survives screen lock, app switching, and phone closure. You go for a run; your book comes with you. No app store, no subscription, no cloud — just a URL on iOS or Android.

This is the **top-level overview** of where TaleTrek is heading — the journey, not the spec.

---

## How we plan

Each layer decomposes the one above it:

```text
VISION   "What problem does this project solve?"     VISION.md
  │
ROADMAP  "What directions / milestones?"   (this)     ROADMAP.md
  │
PRDs     "Detailed requirements per area"             docs/prds/   (forthcoming)
  │
EPICS    "Trackable feature groups"
  │
ISSUES   "Specific, actionable work items"
  │
PRs      "Implementation against issues"
  │
RELEASES "Ship it, tag it, communicate it"
```

The launch scope is **locked to the read-aloud core**: upload, parse, clean, speak, and play in the background. Everything else is deferred.

---

## Themes

Four strategic directions make up the launch:

| Theme | What it means |
|-------|---------------|
| **Upload** | Accept any common ebook format and extract clean, readable text — the pipeline starts here |
| **Speak** | On-device neural TTS (Piper, via WebAssembly) with voice choice and speed control — no cloud, no cost |
| **Jog** | Background-safe playback that survives screen lock, app switch, and phone closure — the hands-free experience that defines the product |
| **Clean** | Strip links, images, footnotes, and noise — only the story flows through the speaker |

---

## Launch — Read-Aloud Core

Six milestones, each shipping a demoable increment built on the last. The product is built **upload-first** through M0–M2 (getting a book in and reading it), then M3 delivers the breakthrough — background playback — and M4–M5 polish it into a complete experience.

| # | Milestone | Ships (user-visible) |
|---|-----------|----------------------|
| M0 | **Foundation** | The app installs as a PWA, boots up, stores data durably across restarts, and works offline from first launch — a functional shell ready for features |
| M1 | **Upload & Read** | Upload a PDF, EPUB, MOBI, or TXT file; the app extracts the text and displays it in a clean reader view — your book, in the browser, stored for next time |
| M2 | **Speak** | Tap play and the app reads to you using on-device neural TTS — choose a voice, adjust speed, pause and resume — audio plays inline while you read along |
| M3 | **Jog Mode** | Lock your phone and the audio keeps playing — pre-rendered audio chunks flow through the `<audio>` element with Media Session lock-screen controls on iOS and Android |
| M4 | **Clean Reading** | Links, images, footnotes, and page numbers are automatically skipped — only the story reaches your ears, with configurable filters and a pronunciation dictionary |
| M5 | **Library & Offline** | Your full book collection in one place, with reading progress, resume-where-you-left-off, cached TTS models for true offline, and a polished installable PWA |

### M0 — Foundation
The app installs and runs as a Progressive Web App. It boots up, stores its data durably in IndexedDB so nothing is lost across restarts, registers a Service Worker so the shell works offline from first load, and presents a clean UI — landing page, reader view, and settings. Out of the box it works without any external dependencies, API keys, or network calls. This is the foundation every feature builds on.

### M1 — Upload & Read
Upload a book — PDF, EPUB, MOBI, or TXT — through the browser's native file picker. The app parses the file format, extracts the text, and displays it in a clean, scrollable reader view. The parsed book is stored in IndexedDB so it persists across sessions without re-uploading. Each format is handled by its appropriate parser: PDF via PDF.js, EPUB via its internal HTML structure, MOBI via a dedicated parser, and TXT directly. This milestone proves the full ingest pipeline — from file to readable text — works in the browser.

### M2 — Speak
Tap play and TaleTrek reads to you. Piper TTS — a neural speech synthesis engine — runs entirely in the browser via WebAssembly, converting text into natural-sounding audio with no cloud calls. Choose from available Piper voices, adjust playback speed, and pause or resume at any point. Audio plays inline alongside the reader view so you can follow along visually. This milestone delivers the core text-to-speech experience: your book, spoken aloud, on any device, for free.

### M3 — Jog Mode
This is the breakthrough milestone. Text chunks are pre-rendered into audio buffers ahead of the current playback position, then played through the standard `<audio>` element with the Media Session API configured for lock-screen controls. Because iOS and Android both guarantee background playback of audio media, the story keeps flowing when the screen locks, when you switch apps, and even when the browser is backgrounded. Lock-screen controls — play, pause, skip forward and back — appear automatically. Smart pre-generation ensures the next chunk is always ready before the current one finishes. This is what makes TaleTrek usable for jogging, commuting, and any hands-free scenario.

### M4 — Clean Reading
The text cleaning pipeline ensures only the story reaches your ears. Before text is sent to TTS, it passes through configurable filters that strip URLs and hyperlinks, image markers and alt-text, figure captions, footnote references, page numbers, and repeated headers or footers. A pronunciation dictionary lets users correct how specific words or names are spoken. Filters are toggleable — skip everything by default, or fine-tune what stays and what goes. This milestone transforms raw extracted text into a smooth, uninterrupted listening experience.

### M5 — Library & Offline
The app becomes a complete reading companion. A library view manages multiple books — cover thumbnails, titles, last-read position, and progress percentage. Reading progress syncs within the app so you resume exactly where you left off, even after closing and reopening days later. Piper TTS voice models are cached in IndexedDB so the entire pipeline — upload, parse, clean, speak, play — works with zero internet after the first load. The PWA is polished with app icons, a splash screen, an install prompt, and full-screen standalone mode. This milestone ships the product people install and use daily.

---

## Beyond the core — M6 through M13

With the read-aloud core (M0–M5) shipped, later milestones deepen the experience: **M6** adds an optional AI transform layer, **M7** makes the reader comfortable on any screen, **M8** makes resume instant by caching audio, **M9** (deferred) was to fix mobile playback, **M10** extracts real chapter structure from PDFs, **M11** replaces M9's approach with a pluggable engine architecture plus pausable synthesis, **M12** speeds up pre-rendering with parallel synthesis, and **M13** streams whole-book AI transforms in place.

| # | Milestone | Ships (user-visible) |
|---|-----------|----------------------|
| M6 | **AI Transforms** | Optional post-processing that cleans OCR noise, translates, summarizes, or simplifies a book — whole-book or per-paragraph — using your own cloud key. Disabled by default |
| M7 | **Reader UX & Mobile** | A responsive, mobile-first reader: chapter outline, minimized playback controls with an overflow menu, a "go to current paragraph" affordance, and auto-scroll to the resumed position on first Play |
| M8 | **Audio Cache** | Reopening a book resumes playback instantly because already-synthesized audio is reused. A local, on-device cache — no sync, no upload |
| M9 | **Mobile Streaming Playback** | ⏸ *Deferred per ADR-0010.* A separate mobile playback engine, superseded for the common case by M11's approach. The design stays documented as the fallback path |
| M10 | **PDF Structure Extraction** | PDFs with an embedded outline split into real chapters on upload — no button click required. PDFs without an outline fall back to AI |
| M11 | **Pluggable Playback Engines, Pausable Synthesis** | Mobile playback defaults to a native engine with no large download or encode step; the older whole-book path stays as a user-selectable fallback. Synthesis becomes pausable and resumable after restart; the mobile reader locks to a synthesis mode while a book is processing |
| M12 | **Parallel Synthesis** | Pre-rendering a book's audio uses multiple synthesis workers at once, so long books are ready sooner. Mobile-safe; reader and playback are unchanged |
| M13 | **Whole-Book Streaming Transform** | AI transforms stream in place as the model generates — text appears paragraph-by-paragraph as it's produced, with pause, resume, and cancel. Playback is blocked while a transform is running |

### M6 — AI Transforms
An optional layer on top of ingest. Disabled by default, so it adds zero overhead until the user opts in with their own cloud key (held in-memory only, never written to disk). The v1 transforms — cleanup, translate, summarize, simplify — run over the whole book from the library; results replace the source text and the original file stays recoverable via re-parse. Per-paragraph transforms (AI and deterministic) and pronunciation-hint proposals extend the same engine into the reader. *(See the [M6 PRD](prds/M6-ai-transforms.md) and ADR-0005 — the on-device backend was removed.)*

### M7 — Reader UX & Mobile
The reader becomes comfortable on a phone. The layout is mobile-first: the nav collapses into a drawer, spacing and type scale adapt, and the playback bar collapses to primary controls with an overflow menu for the rest. A chapter outline drawer lists chapters and jumps on tap; a "go to current paragraph" button recenters the reader on what's playing; and on the first Play of a session, the view auto-scrolls to the resumed paragraph. *(See the [M7 PRD](prds/M7-reader-ux-mobile.md).)*

### M8 — Audio Cache
Resume becomes instant. Every paragraph the engine synthesizes is stored locally, so reopening a book days later picks up the existing audio instead of re-running synthesis the device has already done. The cache is bounded and cleared per-book on delete — a purely local optimization with no sync, no upload, no new permission; if evicted, the app transparently re-synthesizes, with the uploaded file as source of truth. *(See the [M8 PRD](prds/M8-audio-cache.md).)*

### M9 — Mobile Streaming Playback *(deferred per ADR-0010)*
This milestone was to fix a mobile playback limitation: the per-paragraph approach can't keep audio flowing on a locked iOS screen. **M11 superseded this approach for the common case** — a native engine removes the need for the streaming pipeline entirely. M9's design stays documented and the dormant scaffolding stays in-tree as the fallback path if real-world iOS behaviour ever degrades. *(See the [M9 PRD](prds/M9-mobile-streaming.md), ADR-0006 for the original design, and ADR-0010 for the deferral.)*

### M10 — PDF Structure Extraction
PDFs ship structural metadata that pre-M10 TaleTrek ignored. PDFs with an embedded outline now split into real chapters directly on upload — no button click required. PDFs without an outline, and formats that carry no structure, fall back to AI. The pre-M10 heuristic detector was removed: it produced too many false positives on real fiction. *(See ADR-0008 for the rationale.)*

### M11 — Pluggable Playback Engines, Pausable Synthesis
Three mobile-quality fixes land together. **(1) Pluggable engines:** mobile playback defaults to a native engine that reuses already-cached audio — no large download, no encode step, no hard cap. The older whole-book path stays as a user-selectable fallback in Settings. **(2) Pausable synthesis:** the upload job can be paused mid-book and resumed later, even after a restart. **(3) Mobile lockdown:** while a book is synthesizing on mobile, the reader pins to a synthesis mode with playback disabled. Desktop is unchanged. *(See ADR-0010.)*

### M12 — Parallel Synthesis
Pre-rendering a book's audio becomes faster. Multiple synthesis workers run at once — bounded so mobile memory stays safe — so long books are ready to listen to sooner. The reader, live playback, and voice management are unchanged; only background pre-synthesis is parallelized. *(See ADR-0011.)*

### M13 — Whole-Book Streaming Transform
Whole-book AI transforms stream in place as the model generates: text appears paragraph-by-paragraph in the reader as it's produced, rather than waiting for the entire book to finish. The user can pause, resume, or cancel mid-stream; an interrupted stream resumes at the last chapter boundary. Playback is blocked while a transform is running, and audio is re-synthesized sequentially on completion. *(See ADR-0012.)*

---

## Future directions *(not current priorities)*

Revisited once the read-aloud core + M6/M7 are shipped and adopted:

- **Native wrappers** — package the PWA with Capacitor for optional App Store / Play Store distribution, unlocking native background services and push notifications.
- **Reading intelligence** — bookmark syncing, skip-by-paragraph and skip-by-chapter controls, and sleep timers. *(Chapter outline + skip-by-chapter landed in M7.)*
- **Platform & ecosystem** — cross-platform desktop app, browser extension to read web articles aloud, and casting to Bluetooth speakers or CarPlay.
- **Advanced voices** — support for additional open-source TTS engines (Coqui, eSpeak), custom voice training, and multi-language / multilingual books.
- **Accessibility** — high-contrast themes, dyslexia-friendly fonts, and screen-reader-optimized navigation.

---

## Status

M0–M5 shipped (read-aloud core complete). For the current milestone-by-milestone status — including M6–M13 and point releases — see [`AGENTS.md`](../AGENTS.md).
