# ADR-0015: Native pivot — Rust kernel + platform-native apps

- **Status:** Accepted
- **Date:** 2026-08-30
- **Supersedes:** `0014-server-hosted-spa-dual-shape.md` — **deleted**; its subject (the personal server + hosted SPA) no longer exists. Also narrows [`0013-off-device-synth-and-portable-bundles.md`](./0013-off-device-synth-and-portable-bundles.md): the `.taletrek` format and desktop synth survive; the personal-server tier (efforts T4/T5 of that track) is removed.
- **Amends:** [`../VISION.md`](../VISION.md) and [`../ROADMAP.md`](../ROADMAP.md) (rewritten in the `native-pivot` effort)
- **Companion:** [`../ideas/native-pivot.md`](../ideas/native-pivot.md) (the why + locked stack) · [`../specs/native-pivot/spec.md`](../specs/native-pivot/spec.md) (execution)

## Context

TaleTrek shipped as an offline-first PWA: parsing, synthesis, and playback all in the browser. The cost of that choice accumulated as a gotchas ledger of nearly 30 entries — ORT WASM deadlocks, a 30 MB FFmpeg core, MSE `<video>` gymnastics for iOS playback, lock-screen pause as an *accepted limitation*, ITP deleting storage after 7 days, wake locks to keep synthesis alive. The product problem was never hard; the browser platform was. ADR-0013 had already routed synthesis to native Rust (desktop CLI + optional server) — routing around the platform rather than committing to it.

A specify-phase review (2026-08-30; Q&A recorded in the ideas one-pager) resolved: input scope broadens to ebooks + documents; TTS is OSS-only; distribution moves to app stores as free downloads; the architecture is one Rust kernel with platform-native UIs; the web becomes a landing page + `.taletrek` reader; and the personal server is scrapped entirely.

## Decision

1. TaleTrek is a **Rust kernel + platform-native apps** product. The kernel (`crates/parse` — future effort, `crates/synth`, `crates/worker`) is exposed to Swift/Kotlin via **UniFFI**; UIs use each platform's recommended stack (SwiftUI, Jetpack Compose; Tauri 2 or egui for the desktop GUI — decided in that effort's spec).
2. **Ship order:** desktop synth processor (parse → synth → `.taletrek` out) → Android → iOS. Free downloads on Play/App Store; the Apple $99/yr fee is accepted.
3. **TTS is OSS-only:** the official `sherpa-onnx` Rust crate (Apache-2.0) runs Piper + Kokoro voices in-process on every platform. System/proprietary TTS is rejected; piper1-gpl is rejected on licensing (G4).
4. **The web is a landing page + `.taletrek` reader** — file-open only, no upload/parse/synth/transforms. The reader accepts iOS lock-screen pause as a demo-class limitation; native apps are the real jog experience.
5. **The personal server and hosted SPA are deleted entirely** — code and docs. Sync/cloud return only via a future ADR.
6. **AI transforms are purged** from the web; they require re-synth, so they belong on the desktop processor, revisited later.
7. **The `.taletrek` v1 format is unchanged** — the sole interchange between all surfaces.
8. **Interim gap accepted:** until `crates/parse` lands, nothing converts ebooks into bundles (the CLI takes bundles only). Pre-release, solo project — acceptable.

Deletions recorded by this ADR: `server/` (crate), `docs/specs/personal-server/`, `docs/specs/server-hosted-spa/`, `docs/deploy-digitalocean.md`, `docs/off-device-synth-track.md`, and ADR-0014 itself, plus the SPA upload/transform pipeline (the full list is the ADR-0015 / native-pivot commit — `git log --grep native-pivot`).

*(2026-10-04: the `docs/specs/` and `tasks/` trees referenced across the docs were folded into commit messages — every effort's record is now `git log --grep '<slug>'`; the paths above are historical.)*

## Consequences

**Positive:**
- The web-platform tax ledger is paid off — the majority of `docs/gotchas.md` entries retire with the pipeline they documented.
- One kernel, three thin apps: parse/synth/encode logic lives in one place (Rust), unit-tested once.
- Native audio sessions make background playback, lock-screen controls, and car integration first-class — the core jog-mode promise, finally unconditional on iOS.
- The `.taletrek` format and `crates/synth` work carry over untouched — the pivot builds on shipped assets.

**Negative:**
- Three app targets for one maintainer (mitigated, not eliminated, by the shared kernel); store release engineering (signing, review, the annual Apple fee).
- "Just a URL" zero-install onboarding is gone; the web reader is second-class on iOS by design.
- Shipped T4/T5 work (personal server, hosted SPA) is deleted rather than frozen; revisiting sync means rebuilding.
- Until effort 2, the repo cannot produce a bundle from an ebook.

## Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| Capacitor wrapper around the existing SPA | Keeps the web constraints (backgrounding, eviction) the pivot exists to escape; lowest cost but ceilings immediately |
| Cross-platform UI framework (Flutter / RN / Kotlin Multiplatform) | The kernel is already Rust; adds a second runtime to maintain without native polish |
| Pure-Rust UIs on mobile (egui/Makepad/Dioxus) | Non-native feel, weak IME/accessibility, store-polish risk; nobody ships store-quality Rust-UI iOS apps |
| Keep the server, frozen in repo | Dead code + docs that lie about the product; user chose total purge |
| System TTS per platform | Free and good on iOS but proprietary — violates the OSS-engine decision; voices inconsistent across platforms |
| Status quo: keep improving the SPA | The off-device track was already the workaround; this finishes the thought instead of maintaining two shapes |
