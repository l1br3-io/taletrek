# TaleTrek

> *Every story is a journey.* — a free, open-source **reading companion** by **l1br3**.

Upload any ebook — PDF, EPUB, MOBI, or TXT — and TaleTrek reads it aloud using text-to-speech that runs entirely on your device. No cloud, no API keys, no subscriptions. Ships as a Progressive Web App: open a URL on iOS or Android, add to home screen, listen with the screen locked.

See [`docs/VISION.md`](docs/VISION.md) and [`docs/ROADMAP.md`](docs/ROADMAP.md) for the full product direction.

## Status

In active development; between phases. Last shipped: **M11 — Pluggable Playback Engines, Pausable Synthesis** (2026-07-19); next phase starts at `/spec` (see [`CHANGELOG.md`](CHANGELOG.md) · [`docs/ROADMAP.md`](docs/ROADMAP.md)).

## Git is the documentation

Each effort's context, decisions, deviations, and outcome are recorded in its commit messages — the completing commit carries a `Context / Decisions / Deviations / Outcome` block. Architecture decisions live in [`docs/adrs/`](docs/adrs). Look up any effort with `git log --grep='<effort-slug>'` (the former spec tree was folded into history on 2026-10-04).

## License

MIT. See [`LICENSE`](LICENSE). TTS engine + voice models are also MIT via `@mintplex-labs/piper-tts-web` — see [`docs/adrs/0002-mit-piper-pipeline.md`](docs/adrs/0002-mit-piper-pipeline.md).
