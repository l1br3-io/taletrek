# T9 — Settings, failure/cancel UX, drag-drop

**Description:** Polish the shell into a resilient utility: persistent settings (output directory, default voice, jobs), cancel that works, failures that explain themselves (typed-error surfacing), and drag-drop as the primary add path (dialog from T7 stays as fallback — drop-zone was explicitly non-gate).

**Work:**
- [x] `desktop/src/gui/settings.rs`: egui-storage-persisted settings — output dir (default: beside input), default voice, jobs (default from T5's native guidance); settings panel/inline edits
- [x] Cancel: per-job cancel button → cooperative flag the executor checks between paragraphs (rayon short-circuit via the existing abort-on-error seam or a check between `synth_all_paragraphs` chunks — whatever the worker seam allows without trait changes); job lands `Cancelled`, queue advances
- [x] Failure surfacing: map `SynthError`/parse errors to human sentences (piper-missing vs predict vs empty-text etc. — the typed variants exist for exactly this); show input path + retry button on the queue item
- [x] Drag-drop: eframe's native file-drop events → enqueue (multi-file, dedup by path); formats restricted to the CLI's supported set, others rejected with a visible reason
- [x] Queue tests: cancel transition, retry transition (pure seams)

**Acceptance:**
- [x] Cancel mid-job → `Cancelled` state, next job starts, no half-written bundle on disk (atomic write or temp+rename per existing bundle-write pattern)
- [x] Each typed error has a human-readable surfacing (spot-check by forcing one: e.g. corrupt input file)
- [x] Drag-drop of an EPUB + a `.taletrek` enqueues convert + re-voice respectively; a `.png` is rejected with a reason
- [x] Settings survive restart (egui storage); gates green

**Verify:** gates + manual transcript (cancel, failure, drop, restart persistence).

Gates (2026-09-04): `cargo clippy --workspace --all-targets -- -D warnings` clean · `cargo test --workspace` all suites green (desktop 93 passed, +20 over T8: queue retry ×3; executor cancel-running/cancel-queued/retry, CancellableRunner ×1, convert-core cancel-mid-run + pre-write-check + output-dir, humanize ×2, add_dropped/classify ×3; settings defaults/round-trip/sanitize/run-config/resolve-output ×5) · `cargo check -p taletrek-desktop --no-default-features` clean · `cargo fmt --check` clean · `pnpm verify` green · Xvfb smoke (below).

Design notes:
- **Cancel seam**: one new `SynthError::Cancelled` variant in `crates/synth` (4 lines; the enum is typed-for-exactly-this and the runner/encoder *traits* are untouched). `CancellableRunner<R>` wraps every production factory's runner and raises it per-predict → rayon's abort-on-first-error unwinds the pool at the next paragraph; `ensure_not_cancelled` checks the same flag at stage boundaries (after load, after voice resolve, and critically **before the bundle write** — a cancelled job can never half-write; bundle_io stays as-is). The executor flips the flag + ticks the queue `Cancelled` immediately; the dying thread's terminal `Failed` no-ops against the already-Cancelled row and its `Exited` admits the next job. A fresh flag per spawn so a retried job never inherits a flipped one. Cancel during the blocking voice *download* takes effect at the next boundary (interrupting uread mid-chunk would need worker changes — out of scope by task design).
- **Failure surfacing**: `humanize_error` walks the anyhow chain and maps the first typed cause it knows (every `SynthError` variant, `ParseError`, `UnsupportedExtensionError`, `FullInputError` → "re-voice it instead", `BundleError::UnknownSchema` → "update TaleTrek"); unknown chains keep the full context-first `{err:#}` rendering. `Failed` rows now also show the full input path + a Retry button.
- **Retry**: `QueueEvent::Retried` + `Queue::retry` (Failed|Cancelled → Queued, same slot + voice snapshot). Executor's `pump` picks it up like any queued job.
- **Drag-drop**: `ctx.input(i.raw.dropped_files)` (egui 0.35 — dropped files live on `RawInput`, reported on drop frames) → `add_dropped` → `classify_drop` per path (case-insensitive; `.taletrek` → ReVoice, the CLI's eight source extensions → Convert, else reject with `DROP_ACCEPTED` in the reason). Dedup by path via a HashSet seeded from the queue — idempotent even if a platform reported the drop on consecutive frames. The report (enqueued/duplicates/rejected+reasons) renders under the buttons until the next drop.
- **Settings** (`settings.rs`): per-field egui-storage keys (`taletrek.default-voice` kept from T8 so existing choices survive; `taletrek.settings.output-dir` empty=beside-input; `taletrek.settings.jobs` 0=default) — no serialized struct to version. `RunConfig { jobs, output_dir }` is the pure snapshot `pump` passes down; jobs default = `NATIVE_DEFAULT_JOBS` (T5 guidance, const — panic-free under `--no-default-features`). Output redirect keeps the default's file name (`resolve_output`), creating the dir on demand.
- `native_jobs()` (T7) folded into `RunConfig`/`settings`; spawner seam grew `(CancelFlag, RunConfig)` args.

Manual pass (2026-09-04, agent session — Xvfb :99 + `TALETREK_RENDERER=glow`, XTEST pointer via python-xlib, ffmpeg x11grab screenshots, analysis-vision OCR):
1. Shell renders with the T9 surface: drop hint under the buttons, collapsed `▸ Settings`, Voice, Queue + drop-invite empty message. T8's persisted Cori radio loaded through the new `Settings::load` (voice-key continuity).
2. Settings panel opens: `Output folder [beside each input] Browse…` + `Synth workers [2] default: 2`.
3. DragValue dragged → `[16] explicit` + `Default` button appears.
4. **Restart persistence, live**: app relaunched → `[16] explicit` still rendered. Under the hood: eframe's 30 s autosave only fires on *painted* frames (idle-then-SIGKILL inside the window loses the write; graceful close or any frame >30 s after the change flushes it — standard eframe durability, same as T8's voice pick). `app.ron` confirmed carrying all three keys (`"16"`, `""` dir, Cori); smoke's jobs entry then removed from the host's real storage to restore defaults.
5. Cancel / failure / drop routing pinned deterministically at the seams (executor + job-core tests above) rather than a timed UI race: cancel-running flips the real flag and the follower runs to `Done`; cancelled runs leave **no** output file (mid-run wrapper + pre-write check paths both pinned); corrupt-bundle + unsupported-extension failures carry human sentences (`humanize` suite), the same sentences the rows render.
6. Harness gotchas: (a) `WAYLAND_DISPLAY` leaks into harness shells — winit prefers it and the window silently opens on the host compositor, not Xvfb (pass `env -u WAYLAND_DISPLAY`); (b) `setsid` as a background job doesn't fork — the tool's timeout group-kill reaps it; use `setsid --fork`; (c) `pkill -f <pattern>` matches the invoking shell's own command line and kills the harness — bracket a char (`[t]aletrek`); (d) DragValue drags need the row's exact y (probe-crop first) and generous horizontal travel; (e) persisted widget state (CollapsingHeader open) survives restarts — don't blindly re-click toggles in fresh sessions.

**Dependencies:** T8
**Files:** `desktop/src/gui/settings.rs`, `desktop/src/gui/{mod,executor,queue}.rs`, `desktop/src/gui/views/mod.rs`, `crates/synth/src/synth.rs` (one error variant)
**Docs:** none beyond rustdoc
**Estimated scope:** M
