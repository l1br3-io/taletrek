# T5 — CLI default flips native; overrides + engine-parity test

**Description:** Make `taletrek-desktop synth`/`resynth` use the in-process engines by default (features on in `desktop/Cargo.toml`), demote `--piper`/`--ffmpeg` to explicit subprocess overrides, and pin the engine-parity invariant: same text ⇒ same cache keys regardless of engine. Also updates the dev ergonomics (`just` recipes, `docs/developing.md` command rows) so "no external binaries" is the default experience.

**Work:**
- [ ] `desktop/Cargo.toml`: default features include `taletrek-synth/sherpa` + `taletrek-synth/native-encode`
- [ ] `run_synth`/`run_resynth` (`desktop/src/main.rs`): default constructs `SherpaRunner` + `NativeOpusEncoder`; `--piper <bin>` switches the runner back to `SubprocessPiperRunner`; `--ffmpeg <bin>` switches the encoder back (independent overrides)
- [ ] Default jobs for the native engine informed by T3's memory note (e.g. clamp); `--jobs` still respected
- [ ] Engine-parity `--ignored` test: synth the fixture text through both engines (stub-free, seeded voice + piper binary + ffmpeg for the subprocess side) → assert identical cache-key sets and both bundles load via `read_book_bundle`
- [ ] Existing `--ignored` e2e keeps running the subprocess path (flags explicit) — prove it still passes
- [ ] `justfile`: `synth`/`resynth` recipes drop the hard-coded `--piper`; `just setup` note updated (piper seeding now optional/test-only); `just synth-fixture` still works
- [ ] `docs/developing.md`: command table reflects native-default + overrides

**Acceptance:**
- [ ] `just chain-fixture` succeeds with no piper/ffmpeg on PATH (verify via a PATH-stripped env)
- [ ] `--piper`/`--ffmpeg` overrides still function (parity test proves it)
- [ ] Cache-key sets identical across engines (parity test)
- [ ] All gates green: clippy, `cargo test --workspace`, `--ignored` both paths, `pnpm verify` untouched-web

**Verify:** the full gate line + a PATH-stripped `just chain-fixture` run, transcript in this file. **This is Checkpoint A** — record the clean-machine CLI evidence here.

**Dependencies:** T3, T4
**Files:** `desktop/src/main.rs`, `desktop/src/cli.rs`, `desktop/Cargo.toml`, `justfile`, `docs/developing.md`
**Docs:** developing.md rows; setup-section wording (piper optional)
**Estimated scope:** M
