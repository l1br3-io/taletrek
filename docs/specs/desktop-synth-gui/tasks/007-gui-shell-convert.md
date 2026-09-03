# T7 — egui shell + `gui` subcommand + convert happy path

**Description:** The vertical slice that makes the app real: bare `taletrek-desktop` (or `gui` subcommand) opens an eframe window; the user picks a source file (rfd dialog), it queues, executes on a background thread (parse → `synth_all_paragraphs` native → bundle write), live progress renders, and the `.taletrek` lands next to the source. Minimal styling — this task is the path, not the polish (T8/T9 add voice choice and settings).

**Work:**
- [x] `desktop/src/cli.rs`: `Gui` variant; bare invocation (no subcommand) dispatches to GUI; existing subcommands untouched
- [x] `desktop/src/gui/mod.rs`: eframe app — window, queue list (renders T6 `Queue`), add-file button → rfd dialog (multi-select, source-format extensions), per-job progress bars, Done shows output path, Failed shows the message
- [x] `desktop/src/gui/sink.rs`: `ProgressSink` impl forwarding worker progress into a `crossbeam_channel` → GUI thread drains on each frame (`try_recv` loop)
- [x] `desktop/src/gui/executor.rs`: owns the `Queue`; on `next_job()` spawns one background thread running the full job (parse-or-load → synth via worker with native engines → stamp → write `<stem>.synth.taletrek`, default voice = `DEFAULT_VOICE_ID`), feeding `QueueEvent`s back through the channel; voice model auto-acquired via worker's `voices` (blocking download on the job thread, progress surfaced)
- [x] Repo-relative output default: input's directory (`<stem>.taletrek`), mirroring CLI behavior — implemented as `default_synth_output` (`<stem>.synth.taletrek`, exactly the CLI `synth` naming rule)
- [x] `just gui` recipe; `docs/developing.md` gains the row
- [x] Graceful shutdown: window close while running → job thread finishes current paragraph then exits (document behavior; hard-kill is out of scope)

**Acceptance:**
- [x] Bare `taletrek-desktop` opens the window; `parse`/`synth`/`resynth` CLI unchanged
- [x] Pick `crates/parse/testdata/plain.txt` → queue → progress → `.taletrek` written; bundle imports into the web reader (manual check; T11 automates the smoke)
- [x] All queue state changes flow through T6 types — no ad-hoc state in egui code
- [x] `cargo test -p taletrek-desktop` green (queue tests + any new unit seams); clippy clean

**Verify:** gates + manual run transcript in this file (file picked, output path, bundle imported).

Gates (2026-09-03): `cargo clippy --workspace --all-targets -- -D warnings` clean · `cargo test --workspace` 294 passed / 0 failed (11 new: cli dispatch ×2, sink forwarding ×2, executor lifecycle ×6 — add-files ordering, no-double-spawn, sequential FIFO, drain/download/ghost-Exited, panic→Failed, convert-core happy/refuse/full-refusal — + queue pre-start-Failed pin) · `cargo check -p taletrek-desktop --no-default-features` clean.

Headless verification (Xvfb :99 + XTEST driver, agent session): window opens and renders (heading, Add files…, empty state — OCR-confirmed), click → rfd/GTK dialog opens. Synthetic keyboard into XI2-only clients (winit) is not deliverable on this Xvfb (XTEST core→XI2 gap), so the dialog→queue→progress→write pass needs a human at a display — remaining acceptance line above. The same pipeline is covered hermetically end-to-end by `run_convert_job_with` tests (parse-or-load → Started{total} → Progress → bundle beside input, imports via `read_book_bundle`, `generator.app = taletrek-desktop`, full-input refused).

Full pass (2026-09-03, later same day — supersedes the paragraph above): completed end-to-end under Xvfb :99 (1400×1000, `TALETREK_RENDERER=glow`, `WAYLAND_DISPLAY`/`WAYLAND_SOCKET`/`DBUS_SESSION_BUS_ADDRESS` unset, `XDG_RUNTIME_DIR` redirected). The "needs a human" blocker dissolved once the real one was diagnosed: **rfd 0.17's default Linux backend is `xdg_desktop_portal` via zbus, not GTK** — with a live session bus it summons a portal dialog on the real desktop; with every bus path cut (env var + `$XDG_RUNTIME_DIR/bus`) it falls back to a `zenity` **subprocess resolved from PATH** (X11/XI2 was never the problem: XTEST pointer events reach both winit and GTK windows; keyboard was the only true gap). A faithful `zenity` shim on PATH — a real GTK3 `FileChooserDialog` via PyGObject, speaking zenity's stdout contract (`--multiple` → paths joined `|`) — made the picker itself a genuine, click-driven dialog on :99. Transcript: XTEST click `Add files…` → dialog opens in `crates/parse/testdata` → click `plain.txt` → click `Open` → shim prints the path → rfd returns → queue row `plain.txt` **Running 0/5 paragraphs** → **Done → /home/jpt/src/oss/l1br3/taletrek/crates/parse/testdata/plain.synth.taletrek** (113,706 B; manifest `generator.app=taletrek-desktop`, `voiceId=en_US-hfc_female-medium`, 5 Opus segments; no voice download — model already cached). Web reader: imported into the library on `pnpm dev` :8253 via Chrome — status "Imported 'plain' (with audio)" — opened in the reader: both chapters, all 5 cleaned paragraphs, playback bar Ready → Playing → Paused with zero console errors (audible playback under a CDP-driven browser is autoplay-policy flaky; real-hardware audio checks stay with T11/G5). Bundle file is gitignored by `*.taletrek` and left on disk for T11's smoke. Gates re-run after the pass: clippy `-D warnings` clean, `cargo test -p taletrek-desktop` 63/63.

Notes:
- **rfd 0.17 backend reality** (corrects the Work items' "rfd dialog" wording): default features on Linux = `xdg_desktop_portal` (zbus/DBus), **no GTK involved**; when no session bus is reachable it execs `zenity` from PATH. Consequences: (a) on a real desktop the dialog is the portal's (Wayland-native), (b) headless/CI-driving must either supply a bus or a PATH-visible zenity, (c) the "XTEST core→XI2 gap" note above was about keyboard only — XTEST pointer events reach winit fine. If headless GUI automation becomes a recurring need (T9/T11), consider `rfd`'s `gtk3` feature behind a dev flag or document the zenity-shim technique (see this file's transcript).
- `eframe` 0.35: `App::ui` + `App::logic` split (logic = drain/pump/repaint, also runs hidden); `on_exit` joins the running job thread (close waits for the job — bundle never half-written; per-paragraph cancel is T9).
- T6 semantic refinement: `QueueEvent::Failed` now applies from `Queued` too (the executor reports `Started` only after input load — a load failure must terminalize the job or the executor would respawn it forever). No T6 test pinned the old behavior; new test pins the new one.
- Renderer: wgpu default, `TALETREK_RENDERER=glow` GLX fallback (Xvfb/VM/remote sessions; also unblocks headless CI-style verification). `eframe` gains feature `glow`.
- `Queue::cancel`/`get`, `JobKind::ReVoice`, `QueueEvent::Cancelled` carry targeted `allow(dead_code)` until T8/T9 consumers land.

**Dependencies:** T5 (native-default CLI paths reused), T6
**Files:** `desktop/src/cli.rs`, `desktop/src/main.rs`, `desktop/src/gui/{mod,executor,sink}.rs`, `justfile`, `docs/developing.md`
**Docs:** developing.md row
**Estimated scope:** L (5 files — one coherent path; views stay single-window)
