# T7 — egui shell + `gui` subcommand + convert happy path

**Description:** The vertical slice that makes the app real: bare `taletrek-desktop` (or `gui` subcommand) opens an eframe window; the user picks a source file (rfd dialog), it queues, executes on a background thread (parse → `synth_all_paragraphs` native → bundle write), live progress renders, and the `.taletrek` lands next to the source. Minimal styling — this task is the path, not the polish (T8/T9 add voice choice and settings).

**Work:**
- [ ] `desktop/src/cli.rs`: `Gui` variant; bare invocation (no subcommand) dispatches to GUI; existing subcommands untouched
- [ ] `desktop/src/gui/mod.rs`: eframe app — window, queue list (renders T6 `Queue`), add-file button → rfd dialog (multi-select, source-format extensions), per-job progress bars, Done shows output path, Failed shows the message
- [ ] `desktop/src/gui/sink.rs`: `ProgressSink` impl forwarding worker progress into a `crossbeam_channel` → GUI thread drains on each frame (`try_recv` loop)
- [ ] `desktop/src/gui/executor.rs`: owns the `Queue`; on `next_job()` spawns one background thread running the full job (parse-or-load → synth via worker with native engines → stamp → write `<stem>.taletrek`, default voice = `DEFAULT_VOICE_ID`), feeding `QueueEvent`s back through the channel; voice model auto-acquired via worker's `voices` (blocking download on the job thread, progress surfaced)
- [ ] Repo-relative output default: input's directory (`<stem>.taletrek`), mirroring CLI behavior
- [ ] `just gui` recipe; `docs/developing.md` gains the row
- [ ] Graceful shutdown: window close while running → job thread finishes current paragraph then exits (document behavior; hard-kill is out of scope)

**Acceptance:**
- [ ] Bare `taletrek-desktop` opens the window; `parse`/`synth`/`resynth` CLI unchanged
- [ ] Pick `crates/parse/testdata/plain.txt` → queue → progress → `.taletrek` written; bundle imports into the web reader (manual check; T11 automates the smoke)
- [ ] All queue state changes flow through T6 types — no ad-hoc state in egui code
- [ ] `cargo test -p taletrek-desktop` green (queue tests + any new unit seams); clippy clean

**Verify:** gates + manual run transcript in this file (file picked, output path, bundle imported).

**Dependencies:** T5 (native-default CLI paths reused), T6
**Files:** `desktop/src/cli.rs`, `desktop/src/main.rs`, `desktop/src/gui/{mod,executor,sink}.rs`, `justfile`, `docs/developing.md`
**Docs:** developing.md row
**Estimated scope:** L (5 files — one coherent path; views stay single-window)
