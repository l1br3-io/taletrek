# Track — Off-device synthesis + portable bundles

> **Status:** Complete — all five efforts shipped (Tiers 1–3) · Track decision: [`adrs/0013-off-device-synth-and-portable-bundles.md`](./adrs/0013-off-device-synth-and-portable-bundles.md) · Amended by ADR-0014 (live SPA↔server for the hosted shape).

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
| 2 | [`desktop-synth-app`](./specs/desktop-synth-app/spec.md) | Standalone Rust synth tool (text-only bundle in → full bundle out). | ✅ shipped (2026-08-04) → **Tier-2 milestone lands here** |
| 3 | [`spa-bundle-import-export`](./specs/spa-bundle-import-export/spec.md) | TS bundle reader/writer + UI in the SPA. SPA's only new surface. | ✅ shipped (2026-08-07) → **closes the loop** |
| 4 | [`personal-server`](./specs/personal-server/spec.md) | Rust Docker library server + inline synth (worker-mode job queue deferred to a follow-up). | ✅ shipped (2026-08-24) → **Tier-3 milestone lands here** |
| 5 | [`server-hosted-spa`](./specs/server-hosted-spa/spec.md) | The server hosts the SPA itself — live client, hosted mode, full-stack Docker image (ADR-0014 amends alt-2 for this shape). | ✅ shipped (2026-08-29) → **Tier-3 completion** |

Task-level breakdown for all four: [`specs/portable-bundle-format/tasks/README.md`](./specs/portable-bundle-format/tasks/README.md).
Current status: track complete — Tier 1 (SPA alone), Tier 2 (SPA + Desktop), Tier 3 (SPA + personal server, bundle exchange *and* live-hosted) all reachable. Follow-ons (not scheduled): offline-capable hosted mode + cross-mode sync, SSE/WS live job progress, cross-book content-addressed audio store with Range streaming, remote-server mode for the standalone PWA, worker-mode desktop queue, server-side raw-file parsing, multi-user.

## Locked decisions (from ADR-0013)
- **Synth jobs live off the SPA** when a desktop/server is available. The SPA is a consumer.
- **File-based interchange.** No live SPA↔server connection required.
- **On-device Piper stays** in the SPA as offline fallback (Tier 1). Nothing is removed.
- **Parsing stays in the SPA.** Desktop/server ingest *text* (from a bundle), not raw files.
- **Rust** for desktop + server; they share `crates/synth`. The SPA keeps its TS pipeline.
- **Self-hosted trust model** — the server is the user's own (Docker on their box), not a TaleTrek-operated cloud. ADR-0004's "no backend" rejection was about a *TaleTrek-owned* backend; a user-owned one dissolves that objection.

## Resume pointers
- **Decision:** [`adrs/0013-…`](./adrs/0013-off-device-synth-and-portable-bundles.md), amended by [`adrs/0014-…`](./adrs/0014-server-hosted-spa-dual-shape.md)
- **Format:** [`bundle-format.md`](./bundle-format.md)
- **Latest effort spec:** [`specs/server-hosted-spa/spec.md`](./specs/server-hosted-spa/spec.md) (shipped)
- **Deploy the server:** [`deploy-digitalocean.md`](./deploy-digitalocean.md)
- **Next action:** none on this track — see [`ROADMAP.md`](./ROADMAP.md) for what's next.
