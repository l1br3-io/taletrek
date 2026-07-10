# Spike: Piper TTS in the browser

> **Status:** Complete (in-browser). One item remains: real-iOS-device lock-screen test.
> **Track:** B (de-risking). Ran in parallel with M0.

## Goal

Prove the core product thesis — **on-device neural TTS producing audio that survives iOS screen lock** — before committing to M2 integration.

## Verdict: thesis holds (in-browser). Ship `@mintplex-labs/piper-tts-web` for M2.

Synthesis works end-to-end, is faster than realtime, and the package + models + runtime are all **MIT** — which may let us keep TaleTrek fully MIT (see "Licensing" below; would supersede ADR-0001).

## Results (Chrome, desktop, Linux)

Package: `@mintplex-labs/piper-tts-web@1.0.4` + `onnxruntime-web@1.18.0`. Voice: `en_US-hfc_female-medium` (~63 MB). Cross-origin isolated (multi-threaded backend).

| Measurement                          | Value                                   |
| ------------------------------------ | --------------------------------------- |
| Model download (HF CDN → OPFS)       | 1837 ms (one-time, then cached in OPFS)  |
| **Cold synth** (ORT init + load)     | 4346 ms → 6.51 s audio (0.67× realtime)   |
| **Warm synth** (model resident)      | **1104 ms → 6.79 s audio (0.16× realtime)** |
| Output                               | WAV, 22050 Hz, mono, 16-bit PCM (valid)  |
| Heap                                 | ~46 MiB steady, ~89 MiB peak on cold run |
| Text length                          | 115 chars                               |
| WAV size                             | ~288–300 KB per ~6.8 s                  |

Warm performance is **≈6× faster than realtime** — pre-rendering can trivially keep a sliding window of chunks ahead of playback (M3's requirement). 124 voices available across ~30 languages.

## Critical gotcha: pin `onnxruntime-web` to `1.18.0`

The package hardcodes `ort.env.wasm.wasmPaths` to the cdnjs CDN at **1.18.0** (`https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.18.0/`). If the installed `onnxruntime-web` JS wrapper is any other version (e.g. 1.20.1), the JS/wasm mismatch **deadlocks inference** — `predict()` hangs forever with no error.

**Action for M2:** install `onnxruntime-web@1.18.0` exactly, and **mirror the ORT + piper-phonemize wasm/data locally** (the package supports overriding `wasmPaths`) so we don't depend on cdnjs for offline use or reliability.

## Licensing — big finding (may revise ADR-0001)

- `@mintplex-labs/piper-tts-web` — **MIT** (npm-confirmed)
- Piper voice models — **MIT** (rhasspy, original license)
- `onnxruntime-web` — **MIT**

The entire pipeline is MIT end-to-end. This package bundles the **old MIT `rhasspy/piper` phonemizer build**, not the GPL `piper1-gpl` fork. **Recommendation: revise ADR-0001** — TaleTrek can stay fully MIT if we commit to this package (and its MIT phonemizer lineage) rather than the GPL active fork. The GPL acceptance still stands as a fallback if we ever need to swap engines.

## Threading (single- vs multi-threaded)

Multi-threaded (cross-origin isolated, `SharedArrayBuffer`) measured **0.16× realtime**. Single-threaded (no COOP/COEP) could **not** be measured here — the chrome-devtools MCP browser context is globally cross-origin-isolated and the property is sticky across navigations. 

**Architecture recommendation:** default to **single-threaded** (no COOP/COEP headers → any static host including GitHub Pages works; simpler CORS story for model fetches). Even if single-threaded is 2–4× slower than multi-threaded, it would still be ~0.3–0.6× realtime — faster than realtime, adequate for pre-rendering. Treat COOP/COEP as an optional perf optimization, measured on real hardware in M2.

## Remaining item (needs real hardware)

**iOS Safari lock-screen test** — cannot be done from this desktop MCP. To validate before M2 locks in:

1. Deploy the production build somewhere with HTTPS (iOS requires it for SW + installability).
2. On a real iPhone, open the URL, synthesize a sentence, tap play, **lock the screen**.
3. Confirm: audio continues; lock-screen shows the Media Session metadata + play/pause controls.
4. Also confirm the user-gesture requirement: `audio.play()` is called from a tap handler.

Background-audio-via-`<audio>` surviving iOS lock is well-established web behavior (true since iOS Safari 15), so risk is low — but verify on hardware before building M3 on it.

## Recommendation for M2

1. Use `@mintplex-labs/piper-tts-web` (MIT), pin `onnxruntime-web@1.18.0`.
2. Mirror the ORT wasm + phonemize data locally (override `wasmPaths`) — no cdnjs dependency.
3. Pre-download the chosen voice model to OPFS on first use; cache there.
4. Plan single-threaded by default (no COOP/COEP); revisit if perf demands.
5. Run inference in a **Web Worker** (keep UI thread free; survives backgrounding better).
6. Revise ADR-0001 to reflect the MIT pipeline (keep GPL as documented fallback).

## Non-goals (this spike)

- Voice quality breadth / multi-language benchmarking — defer to M2.
- Real iOS validation — see "Remaining item" above.
- Web Worker integration — M2 implementation detail.

## Reproducing

Spike app lives at `spike/piper/`. Run:

```
pnpm install
pnpm -C spike/piper dev        # http://localhost:5174
```

Pick a voice → Download model → Synthesize. Console + on-page log show timing, memory, WAV validity, and Media Session support.
