# TaleTrek

> *Every story is a journey.* — a free, open-source **reading companion** by **l1br3**.

Upload any ebook — PDF, EPUB, MOBI, or TXT — and TaleTrek reads it aloud using text-to-speech that runs entirely on your device. No cloud, no API keys, no subscriptions. Ships as a Progressive Web App: open a URL on iOS or Android, add to home screen, listen with the screen locked.

See [`docs/VISION.md`](docs/VISION.md) and [`docs/ROADMAP.md`](docs/ROADMAP.md) for the full product direction.

## Getting started

Prerequisites: Node 24, pnpm 10.31.0.

```sh
pnpm install          # install workspace deps
pnpm dev              # Vite dev server → http://localhost:5173
pnpm build            # production build → web/dist
```

Open <http://localhost:5173/library> to use the app. Architecture, conventions, and the current effort live in [`AGENTS.md`](AGENTS.md); the off-device-synth track overview in [`docs/off-device-synth-track.md`](docs/off-device-synth-track.md).

## Testing

```sh
pnpm verify           # lint + typecheck + test + build (run before commits)
pnpm test             # vitest run (1113 tests)
cargo test -p taletrek-synth   # Rust synth crate + shared fixtures
```

For the **off-device synth** feature (SPA ↔ desktop `.taletrek` bundle round-trip), the step-by-step manual walkthrough — including a 5-minute browser smoke test that needs no Piper/ffmpeg — is in the runbook: [`docs/specs/spa-bundle-import-export/runbook.md`](docs/specs/spa-bundle-import-export/runbook.md).

## Status

In active development; between phases. Last shipped: **M11 — Pluggable Playback Engines, Pausable Synthesis** (2026-07-19); next phase starts at `/spec` (see [`CHANGELOG.md`](CHANGELOG.md) · [`docs/ROADMAP.md`](docs/ROADMAP.md)). Shipped specs live under [`docs/specs/`](docs/specs/).

## License

MIT. See [`LICENSE`](LICENSE). TTS engine + voice models are also MIT via `@mintplex-labs/piper-tts-web` — see [`docs/adrs/0002-mit-piper-pipeline.md`](docs/adrs/0002-mit-piper-pipeline.md).
