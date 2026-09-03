# T5 — CLI default flips native; overrides + engine-parity test

**Description:** Make `taletrek-desktop synth`/`resynth` use the in-process engines by default (features on in `desktop/Cargo.toml`), demote `--piper`/`--ffmpeg` to explicit subprocess overrides, and pin the engine-parity invariant: same text ⇒ same cache keys regardless of engine. Also updates the dev ergonomics (`just` recipes, `docs/developing.md` command rows) so "no external binaries" is the default experience.

**Work:**
- [x] `desktop/Cargo.toml`: default features include `taletrek-synth/sherpa` + `taletrek-synth/native-encode`
- [x] `run_synth`/`run_resynth` (`desktop/src/main.rs`): default constructs `SherpaRunner` + `NativeOpusEncoder`; `--piper <bin>` switches the runner back to `SubprocessPiperRunner`; `--ffmpeg <bin>` switches the encoder back (independent overrides)
- [x] Default jobs for the native engine informed by T3's memory note (e.g. clamp); `--jobs` still respected
- [x] Engine-parity `--ignored` test: synth the fixture text through both engines (stub-free, seeded voice + piper binary + ffmpeg for the subprocess side) → assert identical cache-key sets and both bundles load via `read_book_bundle`
- [x] Existing `--ignored` e2e keeps running the subprocess path (flags explicit) — prove it still passes
- [x] `justfile`: `synth`/`resynth` recipes drop the hard-coded `--piper`; `just setup` note updated (piper seeding now optional/test-only); `just synth-fixture` still works
- [x] `docs/developing.md`: command table reflects native-default + overrides

**Acceptance:**
- [x] `just chain-fixture` succeeds with no piper/ffmpeg on PATH (verify via a PATH-stripped env)
- [x] `--piper`/`--ffmpeg` overrides still function (parity test proves it)
- [x] Cache-key sets identical across engines (parity test)
- [x] All gates green: clippy, `cargo test --workspace`, `--ignored` both paths, `pnpm verify` untouched-web

**Verify:** the full gate line + a PATH-stripped `just chain-fixture` run, transcript in this file. **This is Checkpoint A** — record the clean-machine CLI evidence here.

**Dependencies:** T3, T4
**Files:** `desktop/src/main.rs`, `desktop/src/cli.rs`, `desktop/Cargo.toml`, `justfile`, `docs/developing.md`
**Docs:** developing.md rows; setup-section wording (piper optional)
**Estimated scope:** M

---

## Notes (landed 2026-09-03)

### The worker hoist (T3's wiring hazard, resolved here)

`synth_all_paragraphs` no longer constructs a runner per paragraph: the work
list splits into at most `jobs` contiguous chunks (ceil(total/jobs) each,
floor 1) and `make_runner` fires **once per chunk** — deterministic regardless
of scheduling (worker test: 8 paragraphs @ jobs=2 → exactly 2 constructions).
One chunk == one runner lifetime == one sherpa model load, matching the plan's
per-thread cost model. Subprocess behavior unchanged (construction was already
cheap; spawn-per-predict inside `predict` untouched). Chunk boundaries also
give T9's cancel its natural check points.

### Engine selection (`desktop/src/engine.rs`)

`RunnerSpec::select(--piper)` / `DesktopEncoder::select(--ffmpeg)` pick
native-default vs subprocess per side, independently; builds without the
features error clearly ("pass --piper …"). `DesktopRunner` defers native
construction to first predict (the worker's factory seam is infallible) —
failures surface as the typed `SynthError::VoiceLoad` (worker: missing
espeak-ng-data etc.), proven hermetically. The CLI honors `TALETREK_ESPEAK_DATA`
as an espeak override (mirrors `TALETREK_VOICE_PATH`; the e2e gate env is now
real for the binary too). `effective_jobs`: explicit `--jobs` wins; else 2 for
native (`NATIVE_DEFAULT_JOBS`, T3's ≈470 MB note), CPU count for `--piper`.

### Checkpoint A — clean-machine CLI evidence (transcripts)

PATH-stripped chained synth (`env -i`, `PATH=/nonexistent` — zero PATH
dependence; `ldd` shows no piper/ffmpeg/onnx shared deps):

```
$ env -i HOME=$HOME PATH=/nonexistent target/debug/taletrek-desktop synth \
    --input crates/parse/testdata/plain.txt --output /tmp/plain.synth.taletrek
synth [1/5] 20% … synth [5/5] 100%
synth: 5 segments, voice en_US-hfc_female-medium, 3s → /tmp/plain.synth.taletrek
manifest audio: present, codec opus, normVersion 2, segmentCount 5; first segment magic b'OggS'
```

`just synth-fixture` / `just chain-fixture` (recipes now flag-free): 3 segments
→ /tmp/book.synth.taletrek (1s); 5 segments → /tmp/plain.synth.taletrek (3s).

Engine parity (`--ignored`, seeded cache): `both_engines_produce_identical_cache_key_sets`
— run 1 with **no engine flags** (native default engaged), run 2 with `--piper`
+ `--ffmpeg`; both bundles load via `read_book_bundle`, both full Opus with
real OGG segments, **identical cache-key sets**, same manifest voice. Existing
subprocess e2e (4/4, flags explicit) still green. Full `--ignored` sweep:
sherpa real-model, native-vs-ffmpeg durations, parity, subprocess e2e — all ok.

Gates: `cargo clippy --workspace --all-targets -- -D warnings` clean ·
`cargo test --workspace` 14/14 suites ok · `cargo build --workspace --all-targets`
clean · `cargo check -p taletrek-desktop --no-default-features` compiles
(the cfg guards are real) · `pnpm verify` green (web untouched).
