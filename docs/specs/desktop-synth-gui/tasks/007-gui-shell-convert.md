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
- [ ] Pick `crates/parse/testdata/plain.txt` → queue → progress → `.taletrek` written; bundle imports into the web reader (manual check; T11 automates the smoke)
- [x] All queue state changes flow through T6 types — no ad-hoc state in egui code
- [x] `cargo test -p taletrek-desktop` green (queue tests + any new unit seams); clippy clean

**Verify:** gates + manual run transcript in this file (file picked, output path, bundle imported).

Gates (2026-09-03): `cargo clippy --workspace --all-targets -- -D warnings` clean · `cargo test --workspace` 294 passed / 0 failed (11 new: cli dispatch ×2, sink forwarding ×2, executor lifecycle ×6 — add-files ordering, no-double-spawn, sequential FIFO, drain/download/ghost-Exited, panic→Failed, convert-core happy/refuse/full-refusal — + queue pre-start-Failed pin) · `cargo check -p taletrek-desktop --no-default-features` clean.

Headless verification (Xvfb :99 + XTEST driver, agent session): window opens and renders (heading, Add files…, empty state — OCR-confirmed), click → rfd/GTK dialog opens. Synthetic keyboard into XI2-only clients (winit) is not deliverable on this Xvfb (XTEST core→XI2 gap), so the dialog→queue→progress→write pass needs a human at a display — remaining acceptance line above. The same pipeline is covered hermetically end-to-end by `run_convert_job_with` tests (parse-or-load → Started{total} → Progress → bundle beside input, imports via `read_book_bundle`, `generator.app = taletrek-desktop`, full-input refused).

Notes:
- `eframe` 0.35: `App::ui` + `App::logic` split (logic = drain/pump/repaint, also runs hidden); `on_exit` joins the running job thread (close waits for the job — bundle never half-written; per-paragraph cancel is T9).
- T6 semantic refinement: `QueueEvent::Failed` now applies from `Queued` too (the executor reports `Started` only after input load — a load failure must terminalize the job or the executor would respawn it forever). No T6 test pinned the old behavior; new test pins the new one.
- Renderer: wgpu default, `TALETREK_RENDERER=glow` GLX fallback (Xvfb/VM/remote sessions; also unblocks headless CI-style verification). `eframe` gains feature `glow`.
- `Queue::cancel`/`get`, `JobKind::ReVoice`, `QueueEvent::Cancelled` carry targeted `allow(dead_code)` until T8/T9 consumers land.

**Dependencies:** T5 (native-default CLI paths reused), T6
**Files:** `desktop/src/cli.rs`, `desktop/src/main.rs`, `desktop/src/gui/{mod,executor,sink}.rs`, `justfile`, `docs/developing.md`
**Docs:** developing.md row
**Estimated scope:** L (5 files — one coherent path; views stay single-window)
