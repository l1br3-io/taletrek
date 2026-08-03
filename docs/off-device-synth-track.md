# Track — Off-device synthesis + portable bundles

> **Status:** Active · Track decision: [`adrs/0013-off-device-synth-and-portable-bundles.md`](./adrs/0013-off-device-synth-and-portable-bundles.md) · **Start here**, then drill into the current effort's spec.

## The one-liner
Move the slow, painful part — **synthesis** — off the phone onto standalone Rust apps, and let books flow between apps as portable `.taletrek` files. The default offline-first PWA (on-device Piper) stays unchanged. This track is **additive**.

## Why
Synthesis runs entirely on-device today (Piper-via-WASM in a worker; the upload manager even holds a screen wake lock). iOS freezes background tabs within seconds, so synth stops the moment the user switches apps — and does **not progress** while the app is closed. M11 made it *resumable*, not *backgroundable*. The fix: synth lives in a process that doesn't die when the phone does.

## Architecture

```
                         .taletrek bundle (text + audio)
   ┌──────────────────────────────────────────────────────────┐
   │                                                          ▼
┌─────────────┐   export text-only    ┌────────────────┐   export full    ┌─────────────┐
│   SPA       │ ───────────────────►  │ Desktop (Rust) │ ──────────────►  │   SPA       │
│ (current    │                       │  synth only    │                  │  plays it   │
│  app, TS)   │ ◄───────────────────  │  (native Piper)│  ◄──────────────  │             │
└─────────────┘     import full       └────────┬───────┘   pull jobs       └─────────────┘
       ▲                                          │
       │                  optional worker mode    │
       │                                          ▼
       │                                 ┌────────────────┐
       └──────── browse / stream ───────►│  Server (Rust, │
                                         │  Docker)       │
                                         │ library + jobs │
                                         └────────────────┘
```

**Three standalone apps, one interchange format:**
- **SPA** (TS) — the current app. Upload, parse, play. *Only new feature: import/export books.*
- **Desktop** (Rust) — synth tool. Imports a text-only bundle → runs native Piper → exports a full bundle. Headless-first.
- **Server** (Rust, Docker) — personal library. Stores books/audio, serves the SPA, optional inline synth, worker job queue.
- **`crates/synth`** (Rust) — the reusable core shared by desktop + server: clean → Piper → encode + bundle I/O.

**File-based, not live-coupled:** the SPA does *not* require a server connection. A `.taletrek` file is the bridge. Synth happens off the SPA; the SPA imports finished results.

## Tiers (each independently useful)

| Tier | Apps | What you get |
| --- | --- | --- |
| **1** (exists today) | SPA alone | On-device Piper synth, fully offline. |
| **2** | SPA + Desktop | Off-device synth via bundle exchange — **"close the tab, synth keeps going."** No server. |
| **3** | SPA + Desktop + Server | Central library, multi-device browse, always-on synth, future sharing. |

## The bundle (the universal interchange)

A `.taletrek` is a ZIP: `manifest.json` + `text.json` + `audio/` (one file per paragraph, named by a **content-addressed key** `${voice}:${NORM_VERSION}:${sha256(normalizedText)}`). Two scopes: a single **book bundle** and a whole **library bundle** (N books). Two states: **text-only** (pre-synth) and **full** (post-synth).

Content-addressing means audio from *any* source dedups on import for free — and later enables a shared/community library without new machinery. Full spec: [`bundle-format.md`](./bundle-format.md).

## Efforts (do in order — each is a prerequisite for the next)

| # | Effort | Deliverable | Status |
| --- | --- | --- | --- |
| 1 | [`portable-bundle-format`](./specs/portable-bundle-format/spec.md) | Format spec + Rust `crates/synth` crate (clean → Piper → encode + bundle I/O). No app. | ✅ shipped (2026-08-03) |
| 2 | [`desktop-synth-app`](./specs/desktop-synth-app/spec.md) | Standalone Rust synth tool (text-only bundle in → full bundle out). | 🔨 active (spec drafted) → **Tier-2 milestone lands here** |
| 3 | `spa-bundle-import-export` *(spec not yet created)* | TS bundle reader/writer + UI in the SPA. SPA's only new surface. | ⏸ queued → **closes the loop** |
| 4 | `personal-server` *(spec not yet created)* | Rust Docker library server + worker-mode job queue. | ⏸ queued → **Tier-3 milestone lands here** |

Task-level breakdown for all four: [`specs/portable-bundle-format/tasks/README.md`](./specs/portable-bundle-format/tasks/README.md).
Next action: task [`specs/desktop-synth-app/todo.md`](./specs/desktop-synth-app/todo.md) (Phase 1).

## Locked decisions (from ADR-0013)
- **Synth jobs live off the SPA** when a desktop/server is available. The SPA is a consumer.
- **File-based interchange.** No live SPA↔server connection required.
- **On-device Piper stays** in the SPA as offline fallback (Tier 1). Nothing is removed.
- **Parsing stays in the SPA.** Desktop/server ingest *text* (from a bundle), not raw files.
- **Rust** for desktop + server; they share `crates/synth`. The SPA keeps its TS pipeline.
- **Self-hosted trust model** — the server is the user's own (Docker on their box), not a TaleTrek-operated cloud. ADR-0004's "no backend" rejection was about a *TaleTrek-owned* backend; a user-owned one dissolves that objection.

## Resume pointers
- **Decision:** [`adrs/0013-…`](./adrs/0013-off-device-synth-and-portable-bundles.md)
- **Format:** [`bundle-format.md`](./bundle-format.md)
- **Current effort spec:** [`specs/desktop-synth-app/spec.md`](./specs/desktop-synth-app/spec.md)
- **All tasks, in order:** [`specs/portable-bundle-format/tasks/README.md`](./specs/portable-bundle-format/tasks/README.md)
- **Next action:** [`specs/desktop-synth-app/todo.md`](./specs/desktop-synth-app/todo.md) (Phase 1)
