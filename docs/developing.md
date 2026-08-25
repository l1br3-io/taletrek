# Developing locally

> The dev-loop companion to [`docs/testing.md`](testing.md) (what to *run*)
> and the per-effort runbooks (full smoke loops). Everything below assumes
> [`just`](https://github.com/casey/just) (`cargo install just`, or your
> package manager) — `just` alone lists every recipe.

## Quickstart

| App            | Command                | URL                            | Needs                        |
| -------------- | ---------------------- | ------------------------------ | ---------------------------- |
| SPA / PWA      | `just dev-web`         | <http://localhost:8253>        | nothing (piper is WASM)      |
| Personal server| `just dev-server`      | <http://127.0.0.1:7878>        | `just setup` for synth only  |
| Desktop (CLI)  | `just synth IN OUT`    | writes a `.taletrek` file      | `just setup`                 |

First time in the repo: `just setup` (pnpm install + native piper + seeded
voice into `~/.cache/taletrek/` — no sudo, idempotent).

## SPA — `just dev-web`

- Vite dev server on **:8253** (spells "TALE" on a keypad — project-unique, so
  it never collides with other dev servers; `strictPort` fails loudly rather
  than silently hopping). The throwaway spikes keep 5174/5175.
- Fully self-contained: TTS runs as Piper WASM in the browser; no native deps.
- Prod build / preview: `pnpm build` then `pnpm preview`.

## Personal server — `just dev-server`

- Debug build of `taletrek-server` on **:7878**, bearer token `dev-secret`
  (override with `TALETREK_TOKEN`).
- Boots and serves with **no** piper/ffmpeg present — they're only needed at
  synth time, and the recipe pre-wires `TALETREK_PIPER` at the `just setup`
  cache, so `POST /api/books/:id/synth` just works after setup.
- Browser operator UI at the root URL (log in with the token);
  `curl -fsS http://127.0.0.1:7878/api/health` is the liveness probe.
- After `pnpm build`, the server also serves the **SPA at `/`** (recipe wires
  `TALETREK_STATIC_DIR=web/dist`; a missing dist logs a warning and the server
  stays up headless). The no-JS askama operator panel lives at `/ui/admin`
  (interim until the hosted SPA reaches parity).
- Docker variant (closer to prod): `just docker-server` (data persists in the
  `tt-data` volume).
- Full curl walkthrough (upload → synth → poll → download): the
  [personal-server runbook](specs/personal-server/runbook.md).

## Desktop — `just synth` / `just resynth`

The desktop app is a headless CLI (no long-running process), so "dev-desktop"
is a one-shot synth:

```
just synth crates/synth/tests/fixtures/book-text-only.taletrek /tmp/book.synth.taletrek
# or the shortcut:
just synth-fixture
```

- `--piper` is pre-wired to the `just setup` cache; the voice auto-resolves
  from the seeded cache (no download on first run).
- Re-voice an existing full bundle:
  `just resynth /tmp/book.synth.taletrek en_US-ryan-medium /tmp/book.ryan.taletrek`
- Verify + listen:
  `unzip -p /tmp/book.synth.taletrek manifest.json | python3 -m json.tool`
  then extract an `audio/*.opus` entry and play it (`ffplay`/`mpv`).
- Full guide: the [desktop-synth-app runbook](specs/desktop-synth-app/runbook.md).

## Ports at a glance

| Port | What                       | Why                                        |
| ---- | -------------------------- | ------------------------------------------ |
| 8253 | SPA dev server             | unique ("TALE"), `strictPort`              |
| 7878 | personal server (dev+Docker)| the server's documented default            |
| 5174 | spike/piper (throwaway)    | historical                                 |
| 5175 | spike/web-audio (throwaway)| historical                                 |

## Tests & gates

`just test-web` · `just test-rust` (hermetic) · `just test-e2e` (real
piper+ffmpeg, gate pre-wired) · `just verify` (SPA gates) · `just verify-rust`
(clippy `-D warnings` + tests). Details per layer: [`docs/testing.md`](testing.md).
