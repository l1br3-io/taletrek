# T8 — Voice picker + re-voice queue action

**Description:** Voice choice becomes a first-class GUI concern: a picker backed by the curated catalog (`crates/worker/src/voices.rs`), on-demand download with visible progress, persisted default, and a per-job voice override. Plus the second queue action: re-voice (`resynth`) an existing `.taletrek`.

**Work:**
- [ ] `desktop/src/gui/views/voice.rs`: catalog list (id, name, quality, size) with the current default marked; selecting a not-cached voice downloads it (worker `voices` acquire) with progress shown on the job/queue item; cached voices flagged
- [ ] Voice selection: default persisted via egui storage (`DEFAULT_VOICE_ID` until changed); per-job override when enqueueing (convert + re-voice)
- [ ] Re-voice action: "Add existing bundle…" → rfd `.taletrek` picker → enqueue `JobKind::ReVoice` (full-bundle voice swap via the existing resynth path); completed bundle output `<stem>.<voice>.taletrek` (don't clobber the input)
- [ ] Download progress wired through the queue event stream (extend `QueueEvent` in T6 if needed — keep transitions pure, tests updated)
- [ ] Unit tests: new queue transitions (re-voice happy path, download-progress events) beside `queue.rs`

**Acceptance:**
- [ ] Fresh cache → pick a non-default voice → download progress → job completes with that voice (manifest `voiceId` matches)
- [ ] Re-voice of a full bundle produces a playable bundle with the new voice; input file untouched
- [ ] Queue tests extended and green; clippy clean; no egui types in queue.rs

**Verify:** gates + manual transcript (voice swap + re-voice outputs open in the reader).

**Dependencies:** T7
**Files:** `desktop/src/gui/views/voice.rs`, `desktop/src/gui/{queue,executor,mod}.rs`, `desktop/src/gui/views/mod.rs`
**Docs:** none beyond rustdoc
**Estimated scope:** M
