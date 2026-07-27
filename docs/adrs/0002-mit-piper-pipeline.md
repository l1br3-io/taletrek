# ADR-0002: Keep TaleTrek fully MIT via MIT Piper pipeline

- **Status:** Accepted — supersedes [ADR-0001](./0001-piper-gpl-licensing.md)
- **Date:** 2026-07-11

## Context

ADR-0001 accepted GPL-3.0 for the Piper engine because the active Piper fork
(`OHF-Voice/piper1-gpl`) is GPL, and the MIT `rhasspy/piper` repo was archived.
At the time, no MIT-viable browser pipeline had been verified.

Verification showed that `@mintplex-labs/piper-tts-web` works in-browser and
confirmed the full pipeline is MIT-licensed end-to-end:

- `@mintplex-labs/piper-tts-web` — **MIT** (npm-confirmed)
- Piper voice models — **MIT** (rhasspy, original license)
- `onnxruntime-web` — **MIT**

This package bundles the **old MIT `rhasspy/piper` phonemizer build** (compiled
to WASM), not the GPL `piper1-gpl` fork. It is not actively maintained upstream
(last publish ~2 years ago), but it is functional and license-clean.

## Decision

**Keep TaleTrek fully MIT.** Use `@mintplex-labs/piper-tts-web` (and its MIT
phonemizer lineage) as the TTS engine for M2. This restores the vision's
original "MIT-licensed, forkable" stance.

**GPL-3.0 is demoted to a fallback only.** If this package becomes unusable
(regression, unmaintainable, model incompatibility) and no other MIT engine is
viable, ADR-0001's GPL acceptance still stands as the contingency.

## Consequences

- TaleTrek ships as pure MIT — no GPL boundary, no copyleft obligation, no
  `THIRD_PARTY_NOTICES` GPL disclosure required.
- The vision's "MIT-licensed" claim stands as written; no doc nuance needed.
- **Risk accepted:** `@mintplex-labs/piper-tts-web` is lightly maintained. We
  mitigate by pinning `onnxruntime-web@1.18.0` (see spike) and mirroring the ORT
  + phonemize WASM locally so we control our own runtime artifacts. If the
  package rots, we fork it (it's MIT — we can) or fall back to GPL.
- ADR-0001 is marked **Superseded** but retained for history.

## Supersedes

- [ADR-0001](./0001-piper-gpl-licensing.md) — GPL-3.0 acceptance is now the
  fallback, not the primary decision.
