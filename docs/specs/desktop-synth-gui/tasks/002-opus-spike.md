# T2 — native Opus spike: crate verdict

**Description:** Timeboxed throwaway validation of in-process Opus encode. The original reason the ffmpeg subprocess won was libopus dev-header linking in the pinned toolchain (`crates/synth/src/encode.rs` module docs) — this spike answers whether a safe binding with a vendored/static build clears that bar today. Deliver: crate choice (`audiopus` vs `opus`), static-link proof, and a WAV→Opus/OGG round-trip via the `ogg` crate matching the current ffmpeg output's container shape (OGG/Opus, `.opus`).

**Work:**
- [ ] Throwaway example (same rules as T1 — outside the workspace default build)
- [ ] Encode synthetic PCM (16 kHz mono, the Piper shape — see `pcm.rs`) → Opus → OGG container
- [ ] Decode round-trip (libopus decoder or ffprobe locally) — audio sane, duration close to source
- [ ] Confirm output structure matches what `OpusEncoder` (ffmpeg `-c:a libopus`, OGG) produces well enough for the reader's Web Audio path (same codec, same container)
- [ ] Measure build impact: does the vendored build need cmake/pkg-config at compile time? Static or dynamic libopus? Record in this file
- [ ] Record verdict: crate, feature flags, build deps, bitrate control (must support the 24 kbps default)

**Acceptance:**
- [ ] Verdict recorded: crate + features + link strategy + build-deps list
- [ ] Round-trip proof pasted in this file
- [ ] If both candidates fail static linking: stop, surface to human (documented fallback = GUI keeps ffmpeg for encode only — ask-first decision, per plan risk table)

**Verify:** spike runs, round-trip output verified, findings in this file. Workspace gates unchanged.

**Dependencies:** None (parallelizable with T1)
**Files:** spike code (throwaway), this file
**Docs:** findings inline here
**Estimated scope:** S
