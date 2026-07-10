# ADR-0001: Accept GPL-3.0 for the Piper TTS engine

- **Status:** Superseded by [ADR-0002](./0002-mit-piper-pipeline.md) (kept for history)
- **Date:** 2026-07-11
- **Companions:** [`../../VISION.md`](../../VISION.md), [`../spikes/piper-wasm.md`](../spikes/piper-wasm.md)

## Context

TaleTrek's vision document states the project is "MIT-licensed, forkable, community-driven." The TTS engine that TaleTrek depends on — Piper — has undergone a license change:

- The original `rhasspy/piper` repo (MIT) was **archived in October 2025**.
- Active development moved to [`OHF-Voice/piper1-gpl`](https://github.com/OHF-Voice/piper1-gpl), relicensed to **GPL-3.0**, and is currently "looking for maintainers."
- The Piper voice **models** (`.onnx` files) remain MIT.
- There is no MIT-licensed, actively-maintained Piper engine build.

TaleTrek bundles Piper (compiled to WASM) into the distributed PWA. This looks like static linking, which under GPL-3.0 can make the combined work subject to copyleft obligations.

## Decision

**Accept GPL-3.0 for the Piper engine.** TaleTrek's own application code remains **MIT-licensed**. The Piper WASM bundle is treated as a distinct GPL-3.0 component, documented in `THIRD_PARTY_NOTICES.md` and disclosed clearly in the README.

## Consequences

- TaleTrek's distributed PWA includes a GPL-3.0 component. Downstream forks inherit GPL obligations for the engine portion.
- The vision document's "MIT-licensed" claim must be **nuanced** before launch to "MIT app with GPL-3.0 Piper engine." (Tracked doc update.)
- A `THIRD_PARTY_NOTICES.md` and clear LICENSE disclosure are required pre-launch.
- **Revisit if** an MIT-licensed neural TTS of comparable quality and browser viability emerges — the architecture isolates the engine behind a contract (`docs/prds/M0-foundation.md` keeps TTS out of M0), making a future swap feasible.

## Alternatives considered

1. **Use the archived MIT `rhasspy/piper` build** — license-clean but unmaintained; WASM path unverified. Rejected as a foundation (but the spike may still probe it).
2. **Switch to a different MIT neural TTS** (Coqui forks, other VITS variants) — trades quality/effort for license clarity. Deferred; revisit if GPL becomes a real adoption blocker.
