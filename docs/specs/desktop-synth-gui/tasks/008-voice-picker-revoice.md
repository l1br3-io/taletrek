# T8 — Voice picker + re-voice queue action

**Description:** Voice choice becomes a first-class GUI concern: a picker backed by the curated catalog (`crates/worker/src/voices.rs`), on-demand download with visible progress, persisted default, and a per-job voice override. Plus the second queue action: re-voice (`resynth`) an existing `.taletrek`.

**Work:**
- [x] `desktop/src/gui/views/voice.rs`: catalog list (id, name, quality, size) with the current default marked; selecting a not-cached voice downloads it (worker `voices` acquire) with progress shown on the job/queue item; cached voices flagged
- [x] Voice selection: default persisted via egui storage (`DEFAULT_VOICE_ID` until changed); per-job override when enqueueing (convert + re-voice)
- [x] Re-voice action: "Add existing bundle…" → rfd `.taletrek` picker → enqueue `JobKind::ReVoice` (full-bundle voice swap via the existing resynth path); completed bundle output `<stem>.<voice>.taletrek` (don't clobber the input)
- [x] Download progress wired through the queue event stream (extend `QueueEvent` in T6 if needed — keep transitions pure, tests updated)
- [x] Unit tests: new queue transitions (re-voice happy path, download-progress events) beside `queue.rs`

**Acceptance:**
- [x] Fresh cache → pick a non-default voice → download progress → job completes with that voice (manifest `voiceId` matches)
- [x] Re-voice of a full bundle produces a playable bundle with the new voice; input file untouched
- [x] Queue tests extended and green; clippy clean; no egui types in queue.rs

**Verify:** gates + manual transcript (voice swap + re-voice outputs open in the reader).

Gates (2026-09-04): `cargo clippy --workspace --all-targets -- -D warnings` clean · `cargo test --workspace` all suites green (desktop 73 passed, +10 over T7: queue re-voice happy path; executor add-files-voice ×2, add-bundles, re-voice core ×3 [full bundle + input-untouched, text-only, non-bundle pre-Started failure], dispatch; views cached-flag ×2 + size label) · `cargo fmt --check` clean · Xvfb uptime smoke (window opens, idles, exits clean).

Design notes:
- **No `QueueEvent` extension needed** — download progress already flows as `WorkerMsg::Download` render-ephemera (T6/T7 design: the queue deliberately does not model it). The re-voice job's download rides the same sink; the T6 transitions were already kind-agnostic, so the queue change is a test extension (kind + voice override survive to the terminal state) plus removing `JobKind::ReVoice`'s `allow(dead_code)`.
- **Download stays lazy**: selecting an uncached voice does not fetch — the first job carrying it resolves via the worker's `resolve_voice` on the job thread (progress on that job's row). The picker stays pure choice; the network stays off the UI thread. This is what the acceptance exercised (Ryan + Cori each downloaded inside their first job).
- **Persistence**: eframe gains feature `persistence`; the default voice lives in egui's persisted `Data` under `"taletrek.default-voice"` (read at `new(cc)`, written on picker change). Verified across two GUI restarts (Ryan survived one, Cori the next — screenshots `t0`/`t10-persist`).
- `add_files` now takes the voice (the enqueue-time per-job snapshot); `add_bundles` queues `JobKind::ReVoice`. Both job cores share `resolve_curated` (the boxed resolver closure over the per-job sink).
- Cached-flag check mirrors the worker's cache-hit rule (both `.onnx` + `.json` present); under the real `~/.cache` the flags correctly showed the machine's pre-existing voices (HFC Female + Ryan) while the redirected test cache flagged only what the session downloaded.

Full pass (2026-09-04, agent session — Xvfb :99 1400×1000, `TALETREK_RENDERER=glow`, redirected `XDG_CACHE_HOME` for a fresh cache, zenity-shim technique per T7 with two refinements: autopick driven by GLib `timeout_add` inside `run()`'s mainloop (a thread racing the mainloop loses the response), and XTEST note — python-xlib's `fake_input(event, detail, time, root, x, y)` takes x/y as *keyword* args or they land in `time`/`root`; pointer-motion verification via `query_pointer`):
1. Fresh cache (`/tmp/.../cache`, empty) → GUI up → catalog renders 8 voices, HFC Female (default) radio on, no "downloaded" flags.
2. Click Ryan radio → selected; **persisted** across a GUI restart.
3. Click "Add files…" → rfd → zenity shim (filter "Books & documents") autopicks `crates/parse/testdata/plain.txt` → queue row `plain.txt · convert · en_US-ryan-medium`.
4. Job downloads the real Ryan model from HuggingFace (~63 MiB, cache gains `en_US-ryan-medium.{onnx,json}`, Ryan gains "downloaded") → **Done → crates/parse/testdata/plain.synth.taletrek**; manifest unzipped: `voiceId: en_US-ryan-medium`, `audio: opus, 5 segments`, `generator.app: taletrek-desktop`. (First attempt Failed with the espeak-ng-data error — the redirected cache hid the `just setup`-seeded dir; symlinked it in and the retry ran clean. Environment provisioning, not an app bug; the error message names the missing dir exactly.)
5. Click "Add existing bundle…" → shim (filter "TaleTrek bundles | *.taletrek") autopicks the full `plain.synth.taletrek` → row `re-voice · en_US-ryan-medium` → **Done → plain.synth.en_US-ryan-medium.taletrek**; `sha256sum -c` confirms the input bundle byte-identical afterward.
6. Switch default to Cori (uncached) → re-voice again → Cori model downloads inside the ReVoice job → **Done → plain.synth.en_GB-cori-medium.taletrek**; manifest `voiceId: en_GB-cori-medium`, input still untouched; both Ryan + Cori flagged "downloaded". Queue history shows convert/re-voice tags, Running progress (`0/5 paragraphs`), Done paths, and the one Failed row with its actionable message.
7. GUI restart with the real `~/.cache` env: Cori still selected (persistence), flags now correctly show the machine's actual cache (HFC Female + Ryan), queue empty.
8. Web reader (`pnpm dev` :8253, Chrome via devtools MCP): both re-voiced bundles import — "Imported 'plain' (with audio)" — and open in the reader (2 chapters, 5 paragraphs); playback Ready → **Playing** on the Cori bundle with **zero console errors** (audible playback autoplay-flaky under CDP, per T7; real-hardware audio stays with T11/G5).

Harness gotchas for next time: rfd dialogs resolve serially on the app's blocked UI thread — a killed/stuck zenity makes later dialogs queue up and flush in bursts (explains any stray duplicate rows in transcripts); kill the shim and the pending results flush. The bundles button's live center was x≈170 (the analyzed bounds drift a few px) — verify with a probe screenshot before clicking.

**Dependencies:** T7
**Files:** `desktop/src/gui/views/voice.rs`, `desktop/src/gui/{queue,executor,mod}.rs`, `desktop/src/gui/views/mod.rs`
**Docs:** none beyond rustdoc
**Estimated scope:** M
