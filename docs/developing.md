# Developing locally

> The dev-loop companion to [`docs/testing.md`](testing.md) (what to *run*)
> and the per-effort runbooks (full smoke loops). Everything below assumes
> [`just`](https://github.com/casey/just) (`cargo install just`, or your
> package manager) — `just` alone lists every recipe.

## Quickstart

| App            | Command                | URL                            | Needs                        |
| -------------- | ---------------------- | ------------------------------ | ---------------------------- |
| SPA / PWA      | `just dev-web`         | <http://localhost:8253>        | nothing                      |
| Desktop (GUI)  | `just gui`             | native window (egui)           | `just setup` (voice + espeak-ng-data; no external binaries) |
| Desktop (CLI)  | `just parse IN OUT` / `just synth IN OUT` | writes a `.taletrek` file      | `just setup` (voice + espeak-ng-data; no external binaries)     |

First time in the repo: `just setup` (pnpm install + the seeded voice +
espeak-ng-data the in-process engine needs, plus piper/ffmpeg for the
subprocess overrides and e2e tests — no sudo, idempotent).

> **Post-pivot shape (ADR-0015):** the SPA no longer synthesizes — it imports
> pre-synthesized `.taletrek` bundles and plays them. To get audio into the SPA
> locally, synth a bundle with the desktop CLI and import it in the library.

## SPA — `just dev-web`

- Vite dev server on **:8253** (spells "TALE" on a keypad — project-unique, so
  it never collides with other dev servers; `strictPort` fails loudly rather
  than silently hopping). The throwaway spikes keep 5174/5175.
- Fully self-contained: reader + playback of imported bundles; no native deps.
- Prod build / preview: `pnpm build` then `pnpm preview`.

## Desktop — `just parse` / `just synth` / `just resynth`

The desktop app is a headless CLI (no long-running process), so "dev-desktop"
is a one-shot parse or synth:

```
# source document → text-only bundle (txt/md/html/epub/docx/pdf)
just parse crates/parse/testdata/plain.txt /tmp/plain.taletrek
# or the shortcut:
just parse-fixture

# text-only bundle → full audio bundle
just synth crates/synth/tests/fixtures/book-text-only.taletrek /tmp/book.synth.taletrek
# or the shortcut:
just synth-fixture

# chained one-command: source document → full audio bundle (parse + synth in memory)
just synth crates/parse/testdata/plain.txt /tmp/plain.synth.taletrek
# or the shortcut:
just chain-fixture
```

- Synthesis runs **in-process by default** — the sherpa-onnx TTS engine + the
  vendored libopus encoder, no piper/ffmpeg on `PATH`. The voice auto-resolves
  from the seeded cache (no download on first run). `--piper <bin>` /
  `--ffmpeg <bin>` independently demote either side back to the subprocess
  engines (e.g. `just synth` + A/B-ing encoders). Default `--jobs`: 2 for the
  native engine (each job holds a ~212 MB model), CPU count for `--piper`;
  explicit `--jobs` always wins.
- `synth --input` accepts a source document (`.txt`/`.md`/`.html`/`.epub`/
  `.docx`/`.pdf`) as well as a `.taletrek` bundle — sources are parsed in
  memory first, so nothing intermediate hits disk; the default output keeps
  the synth naming rule (`<stem>.synth.taletrek`). `resynth` stays
  bundle-only.
- Re-voice an existing full bundle:
  `just resynth /tmp/book.synth.taletrek en_US-ryan-medium /tmp/book.ryan.taletrek`
- Verify + listen:
  `unzip -p /tmp/book.synth.taletrek manifest.json | python3 -m json.tool`
  then extract an `audio/*.opus` entry and play it (`ffplay`/`mpv`).
- Full guide: the [desktop-synth-app runbook](specs/desktop-synth-app/runbook.md).

## Desktop GUI — `just gui`

The windowed app (egui): **Add files…** → pick documents (`.epub`/`.txt`/
`.md`/`.html`/`.docx`/`.pdf`, or a text-only `.taletrek`) → each converts to
a full bundle written beside its source (`<stem>.synth.taletrek`, the CLI
naming rule). The voice auto-resolves like the CLI — seeded cache first,
blocking download on first use (progress shown on the job row). Jobs run
one at a time (FIFO); closing the window mid-job waits for that job to
finish so the bundle is never half-written. Bare `taletrek-desktop` (no
subcommand) opens the same window. The renderer is wgpu (Vulkan/GL) by
default; `TALETREK_RENDERER=glow` selects the GLX fallback for
Vulkan-less environments (Xvfb, some VMs/remote sessions).

## Ports at a glance

| Port | What                       | Why                                        |
| ---- | -------------------------- | ------------------------------------------ |
| 8253 | SPA dev server             | unique ("TALE"), `strictPort`              |
| 5174 | spike/piper (throwaway)    | historical                                 |
| 5175 | spike/web-audio (throwaway)| historical                                 |

## Tests & gates

`just test-web` · `just test-rust` (hermetic) · `just test-e2e` (real
piper+ffmpeg, gate pre-wired) · `just verify` (SPA gates) · `just verify-rust`
(clippy `-D warnings` + tests). Details per layer: [`docs/testing.md`](testing.md).
