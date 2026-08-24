# Roadmap

> Directional overview — no dates, no calendar. The *what's next*, not the spec.
> **Current effort:** none active (between phases) — off-device synth track complete: all four efforts shipped 2026-08-03 → 2026-08-24, Tiers 1–3 reachable. The next effort starts at `/spec` on a fresh branch. Shipped specs live under [`docs/specs/`](./specs/).
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
| M9 | Mobile Streaming Playback | ⏸ deferred ([ADR-0010](./adrs/0010-playback-engine-architecture.md)); superseded for the common case by M11 |
| M10 | PDF Structure Extraction | ✅ shipped ([ADR-0008](./adrs/0008-pdf-structure-extraction.md)) |
| M11 | Pluggable Playback Engines, Pausable Synthesis | ✅ shipped ([ADR-0010](./adrs/0010-playback-engine-architecture.md)) |
| M12 | Parallel Synthesis | ✅ shipped ([ADR-0011](./adrs/0011-parallel-synthesis-pool.md)) |
| M13 | Whole-Book Streaming Transform | ✅ shipped ([ADR-0012](./adrs/0012-whole-book-streaming-transform.md)) |

Shipped efforts live under [`docs/specs/`](./specs/). Ship history: [`CHANGELOG.md`](../CHANGELOG.md). ADRs live in [`docs/adrs/`](./adrs/); runtime gotchas in [`docs/gotchas.md`](./gotchas.md).

---

## Future directions *(not current priorities)*

- **Native wrappers** — package the PWA with Capacitor for optional App Store / Play Store distribution.
- **Reading intelligence** — bookmark syncing, skip-by-paragraph/chapter, sleep timers.
- **Platform & ecosystem** — cross-platform desktop app, browser extension, CarPlay/Bluetooth casting.
- **Advanced voices** — additional open-source TTS engines (Coqui, eSpeak), custom voice training, multilingual books.
- **Accessibility** — high-contrast themes, dyslexia-friendly fonts, screen-reader-optimized navigation.

## Active track — Off-device synthesis + portable bundles (ADR-0013)

An **optional, self-hostable companion track** that moves the slow synthesis step off the phone onto standalone Rust apps, with books flowing between apps as portable `.taletrek` files. The default offline-first PWA (on-device Piper) is unchanged — this track is additive. See [`adrs/0013-off-device-synth-and-portable-bundles.md`](./adrs/0013-off-device-synth-and-portable-bundles.md).

Four efforts, each shippable on its own:

| # | Effort | State |
| --- | --- | --- |
| T1 | `portable-bundle-format` — format spec + Rust `crates/synth` crate | ✅ shipped ([spec](./specs/portable-bundle-format/spec.md)) · 2026-08-03 |
| T2 | `desktop-synth-app` — standalone Rust synth tool (import text-only bundle → export full bundle) | ✅ shipped ([spec](./specs/desktop-synth-app/spec.md)) · 2026-08-04 |
| T3 | `spa-bundle-import-export` — TS bundle reader/writer + UI in the SPA | ✅ shipped ([spec](./specs/spa-bundle-import-export/spec.md)) · 2026-08-07 |
| T4 | `personal-server` — Rust Docker library server + inline synth (worker-mode deferred to a follow-up) | ✅ shipped ([spec](./specs/personal-server/spec.md)) · 2026-08-24 |

Tiers: **(1)** SPA alone (on-device synth, exists today) · **(2)** SPA + Desktop (off-device synth via bundle exchange) · **(3)** + Server (central library, always-on synth, sharing).
