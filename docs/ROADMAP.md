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

## Beyond the core — M6, M7, M8, M9, M10 & M11

With the read-aloud core (M0–M5) shipped, the follow-on milestones deepen the experience: **M6** adds an optional AI transform layer, **M7** makes the reader comfortable on any screen, **M8** makes resume instant by caching synthesized audio, **M9** (deferred) was to fix mobile playback with a streaming engine, **M10** extracts real chapter structure from PDFs, and **M11** replaces M9's FFmpeg approach with a pluggable engine architecture defaulting to native Web Audio — plus pausable synthesis and a simpler mobile reader during upload.

| # | Milestone | Ships (user-visible) |
|---|-----------|----------------------|
| M6 | **AI Transforms** | Optional post-processing (your own OpenAI-compatible cloud key) that cleans OCR noise, translates, summarizes, or simplifies a book — plus per-paragraph transforms (AI + deterministic) and an importable key/config |
| M7 | **Reader UX & Mobile** | A responsive, mobile-first reader: a chapter outline, minimized playback controls with an overflow menu, a "go to current paragraph" affordance, and auto-scroll to the resumed position on first Play |
| M8 | **Audio Cache** | Synthesized audio persists across sessions: reopening a book resumes playback instantly because paragraphs already rendered are reused. A content-addressed IndexedDB cache (keyed by voice + normalized text), LRU-bounded to ~500 MB, cleared per-book on delete. Purely on-device; no sync, no upload. |
| M9 | **Mobile Streaming Playback** | ⏸ *Deferred per ADR-0010.* A separate mobile playback engine using MSE on a hidden `<video>`, fed progressively via FFmpeg WASM-encoded fMP4 segments. Superseded for the common case by M11's Web Audio engine; revisited only if real-world iOS Web Audio behaviour degrades. |
| M10 | **PDF Structure Extraction** | PDFs with an embedded outline (`/Outlines`) split into real chapters on upload via pdfjs's `getOutline` — no button click required. PDFs without an outline fall back to AI re-processing (the pre-M10 heuristic detector was removed as too false-positive-prone on real fiction). A library "Re-process outline" sheet offers pdfjs / AI as the two paths. |
| M11 | **Pluggable Playback Engines, Pausable Synthesis** | Mobile playback defaults to a native **Web Audio** engine (decode + schedule paragraph WAVs already in the M8 cache — no 30 MB FFmpeg download, no encode phase, sample-accurate gapless). The FFmpeg whole-book m4a path stays as a user-selectable fallback in **Settings → Advanced**. Synthesis becomes **pausable** and resumable after restart. On mobile, the reader's playback bar locks to a synthesis mode while a book is processing. |

### M6 — AI Transforms
An optional layer on top of ingest. Disabled by default, so it adds zero overhead until the user opts in. One backend behind the engine contract: **cloud** (any OpenAI-compatible endpoint, your key, held in-memory only and never written to disk). The v1 transforms — cleanup, translate, summarize, simplify — run over the whole book from the library; results replace the source text and the original file stays recoverable via re-parse. Pronunciation hints propose candidates the user reviews into the global dictionary. *(The on-device WebLLM backend was removed — see ADR-0005.)*

The M6 extension adds: a **per-paragraph transform** menu in the reader (tap a paragraph, then clean up, translate, summarize, or simplify just that paragraph with AI — or apply deterministic adjustments: casing, whitespace/quote normalization, and find-and-replace); an improved transform modal with clear hierarchy and per-transform descriptions; and **importable cloud credentials** (paste, or import a `.txt` key / a `.json` config carrying `apiKey` and optionally `baseUrl`/`model`). Per-paragraph edits replace the source paragraph in place with an in-memory undo stack (full revert is always available via re-parse).

### M7 — Reader UX & Mobile
The reader becomes comfortable on a phone. The layout is mobile-first: the nav collapses into a hamburger drawer below `sm`, spacing and type scale adapt, and the playback bar collapses to primary controls (prev ¶, play/pause, next ¶) with a **`⋯` overflow menu** for chapter skip, stop, speed, outline, "go to current paragraph", and "transform paragraph". A **chapter outline** drawer lists chapters, highlights the current one, and jumps on tap. A **"go to current paragraph"** button (in the overflow menu, plus a floating button that appears when the active paragraph is scrolled out of view) recenters the reader on what's playing. And on the **first Play** of a session, if the book has a saved position, the view automatically scrolls to the resumed paragraph — so pressing play drops you exactly where you left off.

### M8 — Audio Cache
Resume becomes instant. Every paragraph Piper synthesizes is stored in a **content-addressed IndexedDB cache** keyed by `voiceId + NORM_VERSION + sha256(normalizedText)`, so reopening a book days later picks up the existing audio instead of re-running ~1 s × N of WASM inference the device has already done. Tier 1 (M3's in-memory look-ahead queue) stays as-is; the new persistent tier sits below it, inside `PiperEngine.synthesize`. The cache is LRU-bounded to ~500 MB, cleared per-book when a book is deleted, and survives reloads within the browser's storage window (indefinitely when installed to the home screen). It's a purely local optimization — no sync, no upload, no new permission; if evicted, the app transparently re-synthesizes, with the uploaded file as source of truth. A Settings indicator shows the cached total with a Clear button. This milestone closes the gap between M5's "resume anywhere" promise and the cost of re-rendering long books on every cold start.

### M9 — Mobile Streaming Playback *(deferred per ADR-0010)*
M3's per-paragraph playback — where each paragraph is a separate `<audio>` source swapped on `ended` — works on desktop but **fails on iOS Safari with a locked screen**: iOS blocks JavaScript from starting a new media source without a user gesture, so the current paragraph finishes and then silence. M9 was specified as a separate mobile engine using **MediaSource Extensions (MSE)** on a hidden `<video>` element, fed by FFmpeg WASM-encoded fMP4 segments. **M11 superseded this approach for the common case:** once lock-suspend → tap-resume is accepted as parity with the MSE path's accepted limitation, a native Web Audio engine (decode + schedule the WAVs already in M8's cache) deletes the entire encode step — no 30 MB FFmpeg core, no encode phase, no duplicate storage, no ~7 h cap. M9's MSE design stays documented and the dormant scaffolding (`useStreamingPlayer` stub, `audioSegments` store, `MSE_CODEC`) stays in-tree as the fallback path if real-world iOS Web Audio behaviour ever degrades. *(See ADR-0006 for the original MSE design and ADR-0010 for the Web Audio decision and M9 deferral.)*

### M10 — PDF Structure Extraction
PDFs ship structural metadata that pre-M10 TaleTrek completely ignored. The PDF parser now consumes pdfjs's `doc.getOutline()` (the `/Outlines` bookmark tree, ~40–60% of commercial fiction) and emits real chapters directly at parse time — no "Generate outline" button click required. The pre-M10 heuristic detector (`lib/outline/detect.ts`) was **removed entirely** per ADR-0008: its keyword/numeric/font-size heuristics produced too many false positives on real fiction (`"Part of the reason"` matched as a chapter heading; drop caps and running page headers polluted font-size signals). AI understanding of prose context is strictly better. A library "Re-process outline" sheet offers pdfjs (Tier 1) and AI as the two explicit paths. TXT/MOBI/Markdown books — which ship no structural metadata — now require AI for any splitting; pre-M10 they got a wrong heuristic outline. *(See ADR-0008 for the full rationale and alternatives rejected.)*

### M11 — Pluggable Playback Engines, Pausable Synthesis, Mobile Synth Lockdown
Three mobile-quality fixes land together. **(1) Pluggable playback engines:** mobile playback gets an explicit engine layer — a native **Web Audio** engine (decode paragraph WAVs from M8's content-addressed cache and schedule them gaplessly on an `AudioContext` via `source.start(scheduledEnd)`) becomes the default; the FFmpeg whole-book m4a path (M8.1) stays as a user-selectable fallback in **Settings → Advanced**. Because the paragraph WAVs already exist in the cache, the Web Audio engine performs no encode at all — no 30 MB core download, no `encoding` phase, no duplicate m4a storage, no ~7 h cap (cache misses re-synthesize on demand). The accepted lock-screen limitation is identical to the MSE path's: `AudioContext` suspends on iOS lock, user taps play to resume. **(2) Pausable synthesis:** the upload job can be paused mid-book and resumed later, even after an app restart — the resumable spec is persisted on the book record and the M8 cache fast-forwards through already-synthesized paragraphs on resume. **(3) Mobile synthesis lockdown:** while a book is synthesizing (or paused) on a coarse-pointer device, the reader's playback bar pins to a synthesis mode (progress + Pause/Resume/Cancel) with playback disabled, removing the silent fallback to the lock-broken desktop engine. Desktop is unchanged throughout. *(See ADR-0010 for the engine architecture, M9 deferral rationale, and the real-device spike that gates the Web Audio default.)*

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

M0–M5 shipped (read-aloud core complete). M6 (AI Transforms, incl. per-paragraph transforms + importable key/config), M7 (Reader UX & Mobile), M8 (Audio Cache), and M10 (PDF Structure Extraction) shipped. M9 (Mobile Streaming Playback) is **deferred** per ADR-0010 — superseded for the common case by M11's native Web Audio engine. M11 (Pluggable Playback Engines, Pausable Synthesis, Mobile Synth Lockdown) is in progress. See [`AGENTS.md`](../AGENTS.md) for the current milestone status table.
