# ADR-0016: On-device pipeline on Android

- **Status:** Accepted
- **Date:** 2026-09-14
- **Supersedes:** the "No parse/synth/voice-catalog on device" row in [`../specs/android-app/spec.md`](../specs/android-app/spec.md)'s effort-shape table (the player-only scope), and the "later, once the kernel is proven" deferral of on-device mobile synthesis in [`../VISION.md`](../VISION.md) (the deferral is spent — recorded there with a pointer here).
- **Amends:** [`../ROADMAP.md`](../ROADMAP.md) (the android-pipeline milestone entry)
- **Companion:** [`../specs/android-pipeline/spec.md`](../specs/android-pipeline/spec.md) (execution)

## Context

`android-app` (effort 4) shipped the phone as a **player**: it imports finished `.taletrek` bundles produced on the desktop. A user with a PDF on their phone and no desktop gets nothing — the app won't look at the file. VISION deferred on-device mobile synthesis to "later, once the kernel is proven." The kernel is now proven across three surfaces (desktop GUI, CLI, Android player), and every ingredient the phone needs already exists as a crate: `crates/parse` (bytes in → `ParsedBook`), `crates/synth` (in-process sherpa-onnx + native Opus behind features), `crates/worker` (voice acquire + rayon pool + stamping). sherpa-onnx/onnxruntime cross-build for arm64 was verified in the effort's first task. The gap was orchestration and surface, not capability — and the orchestration lived inside the desktop's egui executor, explicitly non-reusable.

## Decision

1. **Phones are full processors.** The Android app converts source documents (all six kernel formats: EPUB, PDF, DOCX, HTML, MD, TXT) into `.taletrek` bundles on-device: parse → deterministic content-derived book id → voice (curated catalog, real CDN, cached in `filesDir`) → parallel sherpa synthesis (pool capped at 2) → stamped bundle in the existing library root. No desktop involved anywhere in the loop.
2. **The pipeline orchestration lives in the kernel, not per-platform UI code.** `crates/worker::pipeline` owns the cancellable, observable `PipelineJob` (cancellation per paragraph, atomic bundle write, `PipelineEvent` progress); `crates/ffi` exposes it plus the voice catalog behind additive UniFFI wrappers. Kotlin contains UI, permissions, and the foreground-service shell only — the mirror of the read side's "kernel decides, platform obeys."
3. **Accepted costs:** battery/thermal under sustained synthesis (pool capped at 2; ~211 paragraphs/min on an emulator at pool=2 vs ~124 at pool=1 — hardware datapoints still being gathered); APK growth of **~27 MB (arm64) / ~31 MB (x86_64) per ABI** from onnxruntime + sherpa (measured, task 001; universal APK flagged in release notes); a `dataSync` foreground service for long jobs (Android 15's 6 h cap is far above minutes-scale jobs; chunk-stamp-resume is the named fallback).
4. **Consequence for iOS:** everything added is platform-neutral Rust + UniFFI annotations (paths as strings, bytes as `Vec<u8>`, callbacks via interface) — effort 5 (`ios-app`) consumes the same `crates/ffi` surface unchanged.

## Consequences

**Positive:**
- The product promise — any document, read aloud, offline, free — now holds on the device most people actually have.
- Re-import is idempotent by construction (deterministic book ids): same document, one shelf entry, text-only later overwritten by audio.
- Voice URLs and the `.taletrek` v1 format are untouched — bundles move between all three surfaces unchanged (cross-app invariant preserved).
- The desktop's egui executor now has a kernel-grade successor to migrate onto (explicitly out of scope, but the path exists).

**Negative:**
- The reader-only `.so` pays the pipeline's size too (one shared artifact; accepted — a split would double the FFI surface).
- Sustained synthesis costs battery and thermals the player never did; the pool cap and honest progress notification mitigate, hardware datapoints gate any loosening.
- `INTERNET` + `FOREGROUND_SERVICE_DATA_SYNC` permissions arrive with the pipeline (voice downloads + long jobs).
