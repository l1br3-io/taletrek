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

## Future directions *(not current priorities)*

Revisited once the read-aloud core is shipped and adopted:

- **Native wrappers** — package the PWA with Capacitor for optional App Store / Play Store distribution, unlocking native background services and push notifications.
- **Reading intelligence** — automatic chapter detection, bookmark syncing, skip-by-paragraph and skip-by-chapter controls, and sleep timers.
- **Platform & ecosystem** — cross-platform desktop app, browser extension to read web articles aloud, and casting to Bluetooth speakers or CarPlay.
- **Advanced voices** — support for additional open-source TTS engines (Coqui, eSpeak), custom voice training, and multi-language / multilingual books.
- **Accessibility** — high-contrast themes, dyslexia-friendly fonts, and screen-reader-optimized navigation.

---

## Status

Greenfield — no source yet. [`VISION.md`](./VISION.md) holds the problem and goals; this roadmap is directional and will be updated as milestones ship and PRDs land under `docs/prds/`.
