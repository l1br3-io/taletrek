# TaleTrek Native — idea one-pager

> Status: **approved direction** (brainstorm 2026-08-30). The decision record is [ADR-0015](../adrs/0015-native-pivot-rust-kernel-and-native-apps.md); execution effort: [`docs/specs/native-pivot/`](../specs/native-pivot/spec.md). This file preserves the *why* and the specify-phase Q&A that shaped the pivot.

## Problem Statement

How might we turn any ebook/document into listenable audio using each platform's best native capabilities — free apps, an OSS TTS engine, zero web-platform compromises?

## Why pivot (the case that won)

- The gotchas ledger was ~29 entries of web-platform tax (ORT deadlock, 30 MB FFmpeg WASM, MSE `<video>` hacks, iOS lock-screen pause, ITP storage eviction, wake-lock begging). The product problem was never hard — the browser was.
- The off-device synth track (ADR-0013) already routed synthesis to native Rust. The pivot finishes that thought: **the kernel becomes the product; apps are windows onto it.**

## Recommended Direction

One Rust kernel (`crates/parse` + `crates/synth` + `crates/worker`) exposed via **UniFFI** to thin platform-native apps.

| Surface | Role |
| --- | --- |
| **Desktop** (first ship) | "Synth processor": pick a file → parse → rayon synth → `.taletrek` out. GUI + CLI. |
| **Android** | Compose + Media3 player; kernel via UniFFI. Free Play Store download. |
| **iOS** | SwiftUI player; kernel via UniFFI. Free App Store download ($99/yr accepted). |
| **Web** | Landing page (app downloads) + `.taletrek` reader — file-open only, no upload/synth. Demo-class on iOS (lock-screen pause accepted). |
| **Server + hosted SPA** | **Deleted entirely** (code + docs). Sync/cloud only via a future ADR. |

TTS: **OSS only** — sherpa-onnx official Rust crate (Apache-2.0), Piper + Kokoro voices, in-process everywhere. No system TTS; piper1-gpl rejected (G4, GPL).

`.taletrek` v1 format: unchanged — the sole interchange.

## Locked stack (industry-proven + free)

| Layer | Choice | License | Proven by |
| --- | --- | --- | --- |
| FFI bindings | UniFFI (mozilla/uniffi-rs) | MPL-2.0 | Firefox Android/iOS; Element X on both stores |
| TTS runtime | sherpa-onnx official Rust crate | Apache-2.0 | k2-fsa / Next-gen Kaldi; shipped offline TTS apps |
| Inference | ONNX Runtime (under sherpa) | MIT | Microsoft; most-deployed OSS inference engine |
| Parallel synth | rayon (in `crates/worker`) | MIT/Apache-2.0 | ubiquitous |
| Encode | ffmpeg subprocess (in `crates/synth`) | LGPL/GPL binaries | universal; behind the `Encoder` trait |
| Android build | cargo-ndk + plain Gradle project | MIT / OSS | standard production path |
| iOS build | `cargo build --target aarch64-apple-ios` + Xcode | — | standard; UniFFI emits a Swift package |
| Android UI | Kotlin + Jetpack Compose + Media3 | Apache-2.0 | Google official; ExoPlayer lineage = YouTube's player |
| iOS UI | SwiftUI + AVFoundation | free platform SDK | Apple official |
| Desktop GUI | Tauri 2 (lean: egui — decided in the desktop effort's spec) | MIT/Apache-2.0 | most-adopted free Rust desktop GUI |
| CI/release | GitHub Actions (free for OSS) + fastlane (MIT) later | MIT | industry default |

Avoided: piper1-gpl (GPL, G4), Slint (mobile needs GPL/commercial), Flutter/RN/KMP (kernel is already Rust), system TTS (decided: OSS only), cargo-mobile2 scaffolding (hand-rolled Android Studio/Xcode projects are the conservative path).

## Effort sequence (dependency-aware)

1. `native-pivot` — **this effort**: purge + ADR-0015 + VISION/ROADMAP rewrite + landing v1
2. `kernel-parse` — `crates/parse` (EPUB/TXT/HTML/MD/docx/PDF; MOBI open) + CLI file→bundle
3. `desktop-synth-gui` — the processor app; egui-vs-Tauri decided here
4. `android-app` → 5. `ios-app`

## Key assumptions to validate

- [ ] Piper/Kokoro via sherpa-onnx sound competitive vs iOS system voices — prototype before building three apps
- [ ] Rust parsers match TS parser quality (EPUB/TXT easy; PDF hardest; MOBI may defer)
- [ ] UniFFI kernel builds clean for Android + iOS with sane binary size
- [ ] Solo bandwidth holds across three app targets (shared kernel is the mitigation)

## Not doing (and why)

- Personal server + hosted SPA — deleted; apps start fully local/offline
- AI transforms — purged; they need re-synth, so they belong on the desktop processor later
- System/proprietary TTS — OSS-only decision
- On-device mobile synthesis — later, once the kernel is proven
- Further SPA feature work — it's a reader and a landing page now
- Cloud, accounts, DRM — unchanged non-goals

## Open questions (later efforts)

- MOBI in `crates/parse` now or deferred?
- egui vs Tauri for the desktop GUI?
- Apple dev account under l1br3 — owner + $99/yr payer?
