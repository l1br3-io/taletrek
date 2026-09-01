# T9 — Settings, failure/cancel UX, drag-drop

**Description:** Polish the shell into a resilient utility: persistent settings (output directory, default voice, jobs), cancel that works, failures that explain themselves (typed-error surfacing), and drag-drop as the primary add path (dialog from T7 stays as fallback — drop-zone was explicitly non-gate).

**Work:**
- [ ] `desktop/src/gui/settings.rs`: egui-storage-persisted settings — output dir (default: beside input), default voice, jobs (default from T5's native guidance); settings panel/inline edits
- [ ] Cancel: per-job cancel button → cooperative flag the executor checks between paragraphs (rayon short-circuit via the existing abort-on-error seam or a check between `synth_all_paragraphs` chunks — whatever the worker seam allows without trait changes); job lands `Cancelled`, queue advances
- [ ] Failure surfacing: map `SynthError`/parse errors to human sentences (piper-missing vs predict vs empty-text etc. — the typed variants exist for exactly this); show input path + retry button on the queue item
- [ ] Drag-drop: eframe's native file-drop events → enqueue (multi-file, dedup by path); formats restricted to the CLI's supported set, others rejected with a visible reason
- [ ] Queue tests: cancel transition, retry transition (pure seams)

**Acceptance:**
- [ ] Cancel mid-job → `Cancelled` state, next job starts, no half-written bundle on disk (atomic write or temp+rename per existing bundle-write pattern)
- [ ] Each typed error has a human-readable surfacing (spot-check by forcing one: e.g. corrupt input file)
- [ ] Drag-drop of an EPUB + a `.taletrek` enqueues convert + re-voice respectively; a `.png` is rejected with a reason
- [ ] Settings survive restart (egui storage); gates green

**Verify:** gates + manual transcript (cancel, failure, drop, restart persistence).

**Dependencies:** T8
**Files:** `desktop/src/gui/settings.rs`, `desktop/src/gui/{mod,executor,queue}.rs`
**Docs:** none beyond rustdoc
**Estimated scope:** M
