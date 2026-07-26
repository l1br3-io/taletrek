# Roadmap

> Directional overview — no dates, no calendar. The *what's next*, not the spec.
> **Current phase:** M11 — Pluggable Playback Engines (🚧 in progress) — see [`SPEC.md`](../SPEC.md).
> Companion: [`VISION.md`](./VISION.md) — the problem and goals.

TaleTrek is a free, open-source **reading companion**: upload any ebook — PDF, EPUB, MOBI, or TXT — and TaleTrek reads it aloud using on-device text-to-speech. It strips links, images, and footnotes so only the story flows, then plays it as background audio that survives screen lock, app switching, and phone closure. You go for a run; your book comes with you. No app store, no subscription, no cloud — just a URL on iOS or Android.

The launch scope is **locked to the read-aloud core**: upload, parse, clean, speak, and play in the background. Everything else is deferred.

---

## How we plan

### Scope decomposes top-down

```text
VISION   "What problem are we solving?"   docs/VISION.md
  │
ROADMAP  "What directions / milestones?"  docs/ROADMAP.md  (this)
  │
SPEC     "Current phase requirements"     SPEC.md  (root, one per phase)
```

### Each milestone ships through the harness lifecycle

```text
DEFINE → /spec       spec-driven-development             → SPEC.md
PLAN   → /planning   planning-and-task-breakdown          → tasks/plan.md + tasks/todo.md
BUILD  → /build      incremental-implementation + TDD     → source + tests
VERIFY → /test       debugging-and-error-recovery         → pnpm verify green
REVIEW → /review     code-review-and-quality              → sign-off
SHIP   → /ship       shipping-and-launch                  → tasks/archive/<date>-<slug>/{SPEC.md, plan.md, todo.md}
```

When a phase ships, its SPEC.md + plan.md + todo.md archive **together**
under `tasks/archive/YYYY-MM-DD-<slug>/`, and the next phase starts fresh
at `/spec`. A plan never outlives its phase; a spec never outlives its
plan.

---

## Themes

| Theme | What it means |
|-------|---------------|
| **Upload** | Accept any common ebook format and extract clean, readable text — the pipeline starts here |
| **Speak** | On-device neural TTS (Piper, via WebAssembly) with voice choice and speed control — no cloud, no cost |
| **Jog** | Background-safe playback that survives screen lock, app switch, and phone closure — the hands-free experience that defines the product |
| **Clean** | Strip links, images, footnotes, and noise — only the story flows through the speaker |

---

## Milestones

| # | Milestone | State |
|---|-----------|-------|
| M0 | Foundation | ✅ shipped |
| M1 | Upload & Read | ✅ shipped |
| M2 | Speak | ✅ shipped |
| M3 | Jog Mode | ✅ shipped |
| M4 | Clean Reading | ✅ shipped |
| M5 | Library & Offline | ✅ shipped |
| M6 | AI Transforms | ✅ shipped |
| M6.1 | Biometric Key Caching | ✅ shipped |
| M7 | Reader UX & Mobile | ✅ shipped |
| M8 | Audio Cache | ✅ shipped |
| M8.1 | iOS Huge-Book Upload Resilience | ✅ shipped |
| M9 | Mobile Streaming Playback | ⏸ deferred per [ADR-0010](./adr/0010-playback-engine-architecture.md) — superseded for the common case by M11; dormant scaffolding stays as the fallback path |
| M10 | PDF Structure Extraction | ✅ shipped ([ADR-0008](./adr/0008-pdf-structure-extraction.md)) |
| **M11** | **Pluggable Playback Engines, Pausable Synthesis** | 🚧 **in progress (current)** — [ADR-0010](./adr/0010-playback-engine-architecture.md) · [`SPEC.md`](../SPEC.md) · [`tasks/plan.md`](../tasks/plan.md) |
| M12 | Parallel Synthesis | ✅ shipped ([ADR-0011](./adr/0011-parallel-synthesis-pool.md)) |
| M13 | Whole-Book Streaming Transform | 🚧 in progress (parallel phase) — [ADR-0012](./adr/0012-whole-book-streaming-transform.md) · [`spec/m13-…`](../spec/m13-whole-book-streaming-transform.md) |

Shipped phases' specs + plans sit under `tasks/archive/<date>-<slug>/`. Ship history: [`CHANGELOG.md`](../CHANGELOG.md). ADRs live in [`docs/adr/`](./adr/); runtime gotchas in [`docs/gotchas.md`](./gotchas.md).

---

## Future directions *(not current priorities)*

- **Native wrappers** — package the PWA with Capacitor for optional App Store / Play Store distribution.
- **Reading intelligence** — bookmark syncing, skip-by-paragraph/chapter, sleep timers.
- **Platform & ecosystem** — cross-platform desktop app, browser extension, CarPlay/Bluetooth casting.
- **Advanced voices** — additional open-source TTS engines (Coqui, eSpeak), custom voice training, multilingual books.
- **Accessibility** — high-contrast themes, dyslexia-friendly fonts, screen-reader-optimized navigation.
