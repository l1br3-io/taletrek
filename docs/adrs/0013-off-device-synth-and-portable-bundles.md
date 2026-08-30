# ADR-0013: Off-device synthesis + portable bundles (self-hostable track)

- **Status:** Accepted — the `.taletrek` format, `crates/synth`, and the desktop synth app **survive**; the personal-server tier (efforts T4/T5 of this track, and ADR-0014 with it) was **removed by the native pivot** — see [`0015-native-pivot-rust-kernel-and-native-apps.md`](./0015-native-pivot-rust-kernel-and-native-apps.md)
- **Date:** 2026-07-31
- **Supersedes:** the "proxy through a TaleTrek-owned backend" rejection in [`0004-api-key-threat-model.md`](./0004-api-key-threat-model.md) (alternative #5) and the launch-scope non-goals in [`../VISION.md`](../VISION.md) / `../../AGENTS.md` ("Cloud TTS/sync/store, accounts, multi-user, no backend").
- **Companion:** [`../specs/portable-bundle-format/spec.md`](../specs/portable-bundle-format/spec.md) · [`../bundle-format.md`](../bundle-format.md)

## Context

Synthesis is the most painful part of TaleTrek. It runs entirely on-device: Piper-via-WASM inside Web Workers, orchestrated by `web/src/lib/upload/manager.ts`. The device must stay awake (the manager acquires a screen wake lock) and the tab alive. iOS Safari freezes background tabs within seconds, so synthesis stops the moment the user switches apps or locks the phone. M11 (pausable synthesis) made it *resumable* — it fast-forwards through the content-addressed cache on return — but it does **not progress** while the app is closed. For a 300-paragraph book that is 30+ minutes of the user's phone being unusable for anything else.

Prior direction (Vision non-goals, ADR-0004 alt #5) rejected any backend. That framing assumed a backend meant "TaleTrek operates a cloud" — a commercial, hosted, multi-tenant service. This ADR introduces a different shape that does not carry that assumption.

## Decision

Add an **optional, self-hostable companion track** for off-device synthesis and portable library interchange. The default experience is unchanged: the SPA remains an offline-first PWA with on-device Piper. Nothing is removed.

The track comprises four efforts, each shippable on its own:

1. **`portable-bundle-format`** — a `.taletrek` interchange format (spec + Rust crate). Foundation; no app.
2. **`desktop-synth-app`** — a standalone Rust app that imports a text-only bundle, synthesizes with native Piper, and exports a full bundle. Headless-first.
3. **`spa-bundle-import-export`** — TS bundle reader/writer + UI. The SPA's *only* new surface.
4. **`personal-server`** — a Rust personal library server (Docker): store, serve, optional inline synth, worker-mode job queue.

### Architecture invariants

- **Synthesis jobs live off the SPA** when a desktop/server is available. The SPA is a consumer, not the synth host. This is what delivers "close the tab, synthesis keeps going."
- **File-based interchange.** The SPA does not require a live server connection. A `.taletrek` bundle is the bridge between all three apps. A whole-library bundle wraps N book bundles.
- **Audio is content-addressed** (existing key `voice + sha256(normalizedText)`), so audio from any source deduplicates on import and later enables an opt-in shared/community library without new machinery.
- **On-device Piper stays** in the SPA as the offline fallback (Tier 1). The track is additive; it never removes the offline-first guarantee.
- **Parsing stays in the SPA.** The desktop/server ingest *text* (from a bundle), not raw files. v1 of the desktop accepts bundles only — no Rust PDF/EPUB/MOBI parsers. (Deferred to a later effort if standalone raw-file synth proves necessary.)
- **Rust** for the desktop and server. They share a `crates/synth` library (clean → native `piper` call → encode + bundle I/O). The SPA keeps its TS pipeline.
- **Self-hosted trust model.** The server holds the user's books, audio, and (eventually) API keys. This is acceptable because the server is the user's own (Docker on their NAS/VPS/box) — the "Jellyfin model." It is **not** a TaleTrek-operated cloud. ADR-0004's rejection was of a TaleTrek-owned backend; this is a user-owned backend, which dissolves that objection.

## Tiers (each independently useful)

| Tier | Apps | Delivers |
| --- | --- | --- |
| 1 (exists today) | SPA alone | On-device Piper synth, offline. |
| 2 | SPA + Desktop | Off-device synth via bundle exchange — "close the tab, synth keeps going." No server. |
| 3 | SPA + Desktop + Server | Central library, multi-device browse, always-on synth, optional worker pool. |

## Consequences

- **Positive:** Synthesis is no longer coupled to the phone staying awake. Piper runs native on a real CPU (far simpler than the WASM/ORT/espeak gymnastics — see gotchas G1/G7/G9/G11). Books become portable files. A shared content-addressed library becomes possible later at low cost.
- **Positive:** The reusable Rust core (`crates/synth`) is exactly the "shared abstraction" the codebase has been missing on the synth side — one pipeline, two host apps.
- **Negative — threat model shift for API keys.** If keys move to the server, the biometric-only model (ADR-0007, wrapped-DEK, gotchas G14/G16) no longer applies server-side. A server compromise leaks keys. This is acceptable under the self-hosted trust model (user's own box) but must be documented for the user. The in-memory default (ADR-0004) stays for the SPA's own AI-transform path; server-side key handling is a separate, later decision under this ADR.
- **Negative — format drift risk.** The bundle format is implemented in two languages (Rust crate, TS SPA). Requires a versioned `manifest.json` (`schemaVersion`) and a shared fixtures set so both sides pass identical round-trip tests. This is the primary ongoing cost.
- **Cost — new build surface.** A Cargo workspace, two new binaries, Docker. Mitigated by headless-first desktop and SQLite-default server.

## Alternatives considered

1. **Storage-only server (no compute).** Rejected — delivers none of the core goal (synth survives app close). The painful part is the *computation*, not the storage.
2. **Live SPA↔server connection (cloud sync).** Rejected for v1 — adds auth, real-time progress, conflict resolution, and weakens offline-first. File-based bundle interchange is simpler and sufficient; a live server API remains available to the server's own clients (desktop worker mode) without the SPA needing it.
3. **Drop on-device Piper entirely.** Rejected — breaks Tier 1 / offline-first and discards working code. Kept as fallback.
4. **TaleTrek-operated hosted cloud.** Out of scope and explicitly not this. The product stays FOSS and self-hostable; sustainability is not pursued via a hosted paywall.

## Open questions (deferred to later efforts)

- Raw-file parsing in Rust (desktop standalone mode without a bundle prerequisite) — deferred; v1 desktop is bundles-only.
- Multi-user accounts / sharing ACLs — deferred until Tier 3 is in use and demand is real.
- Server-side API-key handling specifics — a follow-up ADR under this one when the server gains key storage.
