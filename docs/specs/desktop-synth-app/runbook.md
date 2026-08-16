# Runbook — Desktop synth end-to-end smoke test

> Effort 2, task T2.7. The `#[ignore]`d integration tests
> (`desktop/tests/synth_e2e.rs`) prove the wiring; this runbook proves the
> **audio actually plays** — the one assertion a test can't make. Tier-2
> ("close the tab, synth keeps going") is satisfied when this run succeeds.

This is a **manual, human-run** smoke test (spec § Validation gates). It is not
CI. Run it once before declaring effort 2 shipped, and again whenever you touch
`crates/synth`'s synth path or the desktop binary's `synth`/`resynth` handlers.

## Prerequisites

**Quick path:** `pnpm setup:native` (i.e. [`scripts/setup-native.sh`](../../../scripts/setup-native.sh)) installs piper to `~/.cache/taletrek/piper/` and pre-seeds the default voice into `~/.cache/taletrek/voices/`, then prints the exports to use. The steps below are the manual equivalent.

1. **`piper` on `PATH`.** Install from
   <https://github.com/rhasspy/piper/releases> (prebuilt binaries) or build
   from source. Verify: `piper --help` prints usage.
2. **`ffmpeg` on `PATH`.** Must be built with `libopus` (`-c:a libopus`).
   Verify: `ffmpeg -version` lists `--enable-libopus` (most distro builds do).
3. **A Piper voice model** — at minimum the `.onnx` + sibling `.json`. Two ways:
   - **Recommended (offline, reproducible):** let `taletrek-desktop synth`
      download the default curated voice on first run into
      `~/.cache/taletrek/voices/`. Requires network on the first run only.
   - **Manual (fully offline):** download both files from HuggingFace and place
      them side-by-side. Note HF names the config `<voice>.onnx.json` — save it
      as `<voice>.json` (extension replaced), which is the layout the synth
      invocation (`--config`) and the e2e gate expect:
      ```
      https://huggingface.co/diffusionstudio/piper-voices/resolve/main/en/en_US/hfc_female/medium/en_US-hfc_female-medium.onnx
      https://huggingface.co/diffusionstudio/piper-voices/resolve/main/en/en_US/hfc_female/medium/en_US-hfc_female-medium.onnx.json
      ```
      Point `--voice-path` at the `.onnx` (the `.json` is auto-discovered).

## 1. Synth a text-only bundle → full Opus bundle

Build the binary once:

```
cargo build -p taletrek-desktop
```

Use the committed fixture (the same one the lib's conformance tests load) as
input — it carries two chapters of public-domain text:

```
./target/debug/taletrek-desktop synth \
    --input crates/synth/tests/fixtures/book-text-only.taletrek \
    --output /tmp/book.synth.taletrek
```

The first run downloads `en_US-hfc_female-medium` (~63 MiB) into
`~/.cache/taletrek/voices/` with per-integer-percent progress on stderr.
Subsequent runs hit the cache and skip the download. When synth completes you
should see a final summary line:

```
synth: 3 segments, voice en_US-hfc_female-medium, 4m 17s → /tmp/book.synth.taletrek
```

To use a different voice or skip the cache dir entirely:

```
./target/debug/taletrek-desktop synth \
    --input crates/synth/tests/fixtures/book-text-only.taletrek \
    --voice-path ~/.cache/taletrek/voices/en_US-hfc_female-medium.onnx \
    --output /tmp/book.synth.taletrek
```

## 2. Verify the output manifest

```
unzip -p /tmp/book.synth.taletrek manifest.json | python3 -m json.tool
```

Confirm:
- `audio.present` is `true`
- `audio.codec` is `"opus"`
- `audio.segmentCount` matches the input's distinct paragraph count (3 for the
  fixture — two in chapter one, one in chapter two)
- `generator.app` is `"taletrek-desktop"`
- `book.voiceId` is the voice you synth'd under

## 3. Confirm the Opus audio plays

Extract one segment and play it:

```
# List the audio entries (one per content-addressed paragraph).
unzip -l /tmp/book.synth.taletrek | grep 'audio/'

# Extract + play the first segment.
unzip -p /tmp/book.synth.taletrek audio/<first-key>.opus > /tmp/sample.opus
ffplay /tmp/sample.opus   # or: mpv /tmp/sample.opus
```

You should hear clean speech (a reading of the fixture's first paragraph).
Repeat for at least one segment per chapter.

**This step is the whole point of the runbook** — every other assertion is
already covered by the integration test. If it sounds garbled, truncated, or
silent, file a bug against `crates/synth::encode` before shipping.

## 4. Re-voice the bundle (`resynth`)

```
./target/debug/taletrek-desktop resynth \
    --input /tmp/book.synth.taletrek \
    --voice en_US-ryan-medium \
    --output /tmp/book.ryan.taletrek
```

Re-verify: the new manifest's `book.voiceId` is `en_US-ryan-medium`, the
segment count is unchanged, and a freshly-extracted segment plays with the
new voice's timbre.

## 5. Round-trip back through the SPA

> Effort 3 (`spa-bundle-import-export`) will automate this as a TS bundle
> reader + import UI. Until then, a manual check:

1. Start the dev server: `pnpm dev`.
2. Import `/tmp/book.synth.taletrek` via the reader's import flow.
3. The book appears in the library, chapters are populated, and hitting
   **Play** plays the Opus segments the desktop app synthesized.

If the SPA rejects the bundle, the cross-language contract
(`docs/bundle-format.md`) has drifted — file a bug against the offending side.

## 6. Run the `#[ignore]`d integration tests

These encode steps 1–2 (everything except the audio-plays check) as Rust, so a
future regression in the wiring is caught before re-running this runbook by
hand:

```
# Point the gate at your voice + piper + ffmpeg (ffmpeg/piper default to PATH).
export TALETREK_VOICE_PATH=~/.cache/taletrek/voices/en_US-hfc_female-medium.onnx
# Optional overrides:
# export TALETREK_PIPER_BIN=/usr/local/bin/piper
# export TALETREK_FFMPEG_BIN=/usr/bin/ffmpeg

cargo test -p taletrek-desktop --test synth_e2e -- --ignored --nocapture
```

Both tests (`real_synth_produces_full_opus_bundle`,
`real_resynth_revoices_full_bundle`) should pass. They build their own fixture
in a tempdir, so they don't depend on the committed `.taletrek`.

## Passing criteria

Effort 2 is smoke-clean when **all** of:
- [ ] Step 1 exits 0 and prints the summary line.
- [ ] Step 2 manifest matches (present/opus/count/generator/voiceId).
- [ ] Step 3 audio plays in `ffplay`/`mpv`.
- [ ] Step 4 resynth produces a distinct-voiced, playable bundle.
- [ ] Step 6 integration tests pass under `--ignored`.

Then proceed to T2.8 (final gates).
