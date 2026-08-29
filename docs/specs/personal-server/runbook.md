# Runbook — Personal server end-to-end smoke test

> Effort 4 (`personal-server`), task T12. The `#[ignore]`d integration test
> (`server/tests/server_e2e.rs`) proves the wiring; this runbook proves the
> **audio actually plays on the phone** — the one assertion a test can't make.
> **Tier 3** (*"close every device, synth keeps going"*) is satisfied when this
> run succeeds.

This is a **manual, human-run** smoke test (spec § Validation gates). It is not
CI. Run it once before declaring effort 4 shipped, and again whenever you touch
the server's synth runner (`server/src/synth.rs`), the HTTP handlers, or the
shared `crates/worker` stamp path.

The whole loop is also encoded as the `#[ignore]`d test in §5 — run that first;
it catches any wiring regression before you spend the human time on §4.

---

## Prerequisites

**Quick path:** `pnpm setup:native` (i.e. [`scripts/setup-native.sh`](../../../scripts/setup-native.sh)) installs piper to `~/.cache/taletrek/piper/` and pre-seeds the default voice into `~/.cache/taletrek/voices/`, then prints the exports to use. The steps below are the manual equivalent.

1. **`piper` (rhasspy TTS) resolvable.** This is the neural TTS engine. The
   Debian package named `piper` is the **libratbag mouse-config GUI — wrong
   thing**; the TTS binary ships only via
   <https://github.com/rhasspy/piper/releases>. Install the prebuilt tarball:

   ```
   curl -fsSL -o /tmp/piper.tar.gz \
     https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz
   tar -xzf /tmp/piper.tar.gz -C /opt
   # /opt/piper/piper is the binary; its RUNPATH=$ORIGIN finds the sibling .so
   # files + espeak-ng-data/, so no LD_LIBRARY_PATH is needed.
   export TALETREK_PIPER=/opt/piper/piper   # or add /opt/piper to PATH
   $TALETREK_PIPER --help                    # prints usage → libs resolved
   ```

   (The Docker image does this for you — see §3. The `2023.11.14-2` tag is the
   final release of the now-archived repo, so the URL is immutable.)

2. **`ffmpeg` on `PATH`** (built with `libopus`). Verify:
   `ffmpeg -version | grep -i libopus`. Every distro build we've seen includes
   it; if not, install `ffmpeg` from your package manager.

3. **A Piper voice model** — at minimum the `.onnx` + sibling `.json`. Two ways:
   - **Recommended (offline, reproducible):** let the server download the
     default curated voice on first synth into `$TALETREK_VOICES_CACHE_DIR`
     (default `/data/voices` in Docker, `~/.cache/taletrek/voices/` locally).
     Requires network on the first synth only.
   - **Manual (fully offline):** download both files side-by-side from
      HuggingFace. Note HF names the config `<voice>.onnx.json` — save it as
      `<voice>.json` (extension replaced), the layout the synth invocation
      (`--config`) expects. Then pass `voicePath` to the synth request:

      ```
      https://huggingface.co/diffusionstudio/piper-voices/resolve/main/en/en_US/hfc_female/medium/en_US-hfc_female-medium.onnx
      https://huggingface.co/diffusionstudio/piper-voices/resolve/main/en/en_US/hfc_female/medium/en_US-hfc_female-medium.onnx.json
      ```

4. **`curl`** for the command-line walkthrough below. The server speaks plain
   HTTP/JSON + multipart, so any client works.

---

## 1. Local dev: run the server from source

```
cargo build -p taletrek-server
export TALETREK_TOKEN="$(openssl rand -hex 32)"  # REQUIRED (single-user bearer — ADR-0013)
# Optional overrides (defaults shown):
# export TALETREK_BIND=127.0.0.1:7878
# export TALETREK_DATA_DIR=./data
# export TALETREK_PIPER=piper             # or /opt/piper/piper (see §Prerequisites)
# export TALETREK_FFMPEG=ffmpeg
cargo run -p taletrek-server
```

> Use a real random token (`openssl rand -hex 32`) for anything reachable
> beyond loopback — the server's bind default is `0.0.0.0` (Docker needs it),
> and the token is the entire auth surface. A dev-only throwaway like
> `dev-secret` is fine solely for loopback hacking (the `just dev-server`
> task pins the bind to `127.0.0.1` for exactly that reason); failed logins
> are throttled (10 per 15 min per IP), which is a speed bump, not a
> substitute for entropy.

You should see a `taletrek-server listening` line with the bind addr, data dir,
and voices cache. The server boots + serves **without** `piper`/`ffmpeg`
present; those are only needed at synth time.

Quick liveness check (the only unauthenticated route):

```
curl -fsS http://127.0.0.1:7878/api/health   # → ok
```

Every other route needs the bearer:

```
curl -fsS -H "Authorization: Bearer $TALETREK_TOKEN" http://127.0.0.1:7878/api/books
# → []   (empty library)
```

---

## 2. The end-to-end loop (curl, on a local server)

This mirrors what the `#[ignore]`d test asserts (§5) and what the operator UI
does (§3). Set up once:

```
BASE=http://127.0.0.1:7878
AUTH="Authorization: Bearer $TALETREK_TOKEN"
# The committed text-only fixture — two chapters, no audio yet.
FIX=crates/synth/tests/fixtures/book-text-only.taletrek
```

**(a) Upload** the text-only bundle (multipart; the server ingests by book id):

```
curl -fsS -H "$AUTH" -F "bundle=@$FIX" $BASE/api/books
# → [{"id":"bk_…","audioPresent":false,…}]   (note the id)
```

**(b) Trigger synth** with the default curated voice. Pass `voicePath` instead
of `voice` to skip catalog lookup + network (point at a `.onnx` you already
have); omit both to let the server download the default voice into the cache.

```
ID=bk_…   # from the upload response
curl -fsS -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"voicePath":"/abs/path/to/en_US-hfc_female-medium.onnx"}' \
  $BASE/api/books/$ID/synth
# → {"jobId":"j…-0"}    (202 Accepted — synth runs in the background)
```

**(c) Poll the job** until `status` is terminal:

```
JOB=j…-0
curl -fsS -H "$AUTH" $BASE/api/jobs/$JOB
# repeat until "status":"succeeded" (done reaches total)
```

**(d) Download** the full bundle:

```
curl -fsS -H "$AUTH" -o /tmp/book.synth.taletrek $BASE/api/books/$ID/bundle
```

**(e) Verify the manifest + Opus magic:**

```
unzip -p /tmp/book.synth.taletrek manifest.json | python3 -m json.tool
```

Confirm:
- `audio.present` is `true`
- `audio.codec` is `"opus"`
- `generator.app` is `"taletrek-server"` (provenance stamp — T1–T3)
- `book.voiceId` names the voice actually used — the server rewrites it to the
  effective synth voice (bundle-format contract: importers compute segment
  keys from `book.voiceId`, so the manifest must agree with the keys). With
  the default voice that's `en_US-hfc_female-medium`, regardless of what the
  text-only input's manifest said
- every `audio/<key>.opus` segment starts with the OGG magic `OggS`:

  ```
  unzip -l /tmp/book.synth.taletrek | grep 'audio/'
  unzip -p /tmp/book.synth.taletrek audio/<first-key>.opus | head -c4 | xxd
  # → 00000000: 4f67 6753                                OggS
  ```

**(f) Resynth** — re-voice under a different voice id (same `voicePath` model is
fine; only the stamped `voiceId` + segment keys change):

```
curl -fsS -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"voice":"en_US-ryan-medium","voicePath":"/abs/path/to/model.onnx"}' \
  $BASE/api/books/$ID/resynth
# poll the new job, re-download, confirm book.voiceId flipped + segments still OggS
```

---

## 3. Docker: build + run the image

```
docker build -f server/Dockerfile -t taletrek-server .
docker run -d --name tt \
  -p 127.0.0.1:7878:7878 \
  -e TALETREK_TOKEN=$TALETREK_TOKEN \
  -v tt-data:/data \
  taletrek-server
```

> Since effort 5 (T18) the same command builds the **full stack**: a `node:24`
> stage builds the SPA (`web/dist`) with the workspace-pinned pnpm and the
> runtime bakes it at `/web-dist` (`TALETREK_STATIC_DIR`). No separate
> `pnpm build` step for operators — one image serves the API, the login page,
> and the hosted PWA at `/`.

> `-p 127.0.0.1:7878:7878` keeps the container reachable from the host only.
> To open it to the LAN (the Tier-3 "synth keeps going" deployment), publish
> deliberately (`-p 7878:7878`) **and** set `TALETREK_TOKEN` to a long random
> secret — plain HTTP + a guessable token on a LAN is a read/write library
> for anyone nearby. The piper tarball downloaded at build time is
> sha256-verified (`PIPER_SHA256` in the Dockerfile); voice models downloaded
> at runtime pass a size sanity check before caching.

The `/data` volume holds the library (`library/<book-id>/bundle.taletrek`), the
SQLite index (`taletrek.db`), **and** the voice-model cache (`voices/`) — one
volume, survives restarts. (Piper + ffmpeg are baked into the image; voice
models download on first synth.)

Health check (no token needed):

```
docker exec tt curl -fsS http://127.0.0.1:7878/api/health   # → ok
# or from the host:
curl -fsS http://127.0.0.1:7878/api/health                   # → ok
```

Then run the §2 loop against `http://127.0.0.1:7878` — identical commands.
The operator UI is also available in a browser at `http://127.0.0.1:7878/`
(log in with the token; it sets a cookie).

**Image size:** ~865 MiB as built (`docker images taletrek-server`). The
runtime layer is dominated by the three native pieces, none of which the Rust
binary can shed:

| layer              | size   | why                                                |
| ------------------ | ------ | -------------------------------------------------- |
| `ffmpeg` (apt)     | ~477 M | debian's `ffmpeg` pulls the full codec dep tree    |
| piper (`/opt/piper`) | ~54 M | `piper` + `libonnxruntime` + `libespeak-ng` + data |
| `taletrek-server`  | ~12 M  | the release binary                                 |

The T12 target was "well under a few hundred MiB"; `ffmpeg` alone blows that
budget. The server only invokes `ffmpeg -c:a libopus`, so swapping the apt
metapackage for a stripped / static libopus-only ffmpeg build would cut
~400 MiB — tracked as a follow-up optimization (the task shipped the apt path
because it's the documented, reproducible default).

---

## 4. Import into the SPA — the audio-plays check (Tier-3 proof)

> Every assertion above is already covered by the integration test (§5) except
> this one. **This step is the whole point of the runbook.**

1. Start the SPA dev server: `pnpm dev`.
2. Import `/tmp/book.synth.taletrek` via the reader's **import** button (effort
   3 — the T3 bundle-import flow).
3. The book appears in the library, chapters populate, and hitting **Play**
   plays the Opus segments the server synthesized.

If the SPA rejects the bundle, the cross-language contract
(`docs/bundle-format.md`) has drifted — file a bug against the offending
producer (`generator.app` in the manifest tells you which: `taletrek-server`,
`taletrek-desktop`, or the SPA).

After the resynth round-trip (§2.f), re-import the re-voiced bundle and confirm
the new voice's timbre plays.

---

## 5. Run the `#[ignore]`d integration tests

These encode steps §2 (a)–(e) (everything except the SPA audio-plays check) as
Rust, so a future regression in the server's wiring is caught before re-running
this runbook by hand. They spin the **real built binary** as a subprocess on an
ephemeral port, then drive it over HTTP with the same `piper`/`ffmpeg`/voice
gate the desktop's `tests/synth_e2e.rs` uses.

```
# Point the gate at your voice + piper + ffmpeg (piper/ffmpeg default to PATH).
export TALETREK_VOICE_PATH=/abs/path/to/en_US-hfc_female-medium.onnx
# Optional overrides:
# export TALETREK_PIPER_BIN=/opt/piper/piper
# export TALETREK_FFMPEG_BIN=/usr/bin/ffmpeg

cargo test -p taletrek-server --test server_e2e -- --ignored --nocapture
```

Both tests (`real_synth_produces_full_opus_bundle`,
`real_resynth_revoices_full_bundle`) should pass. They `include_bytes!` the
committed text-only fixture, so they don't depend on a hand-built `.taletrek`.

---

## Passing criteria

Effort 4 is smoke-clean when **all** of:

- [x] §2 (a)–(e) succeeds against a local `cargo run` server: upload → synth →
      poll `succeeded` → download → `manifest.audio.present == true` + Opus
      segments carry `OggS`. *(2026-08-20 @ `70ec7d9`)*
- [x] §2 (f) resynth produces a distinct-voiced, `OggS`-valid bundle. *(2026-08-20 @ `70ec7d9`)*
- [x] §3 `docker build` + `docker run` reaches `/api/health` → `ok`. *(2026-08-20 @ `70ec7d9`)*
- [x] §4 the synthesized bundle imports into the SPA and **audio plays**; the
      resynth'd bundle plays with the new voice. *(2026-08-24 @ `22508db`,
      browser-driven: both bundles import "with audio"; `<audio>` playback
      probes show real segment durations + scheduler auto-advance to
      "Finished", console clean; ryan/hfc segment bytes verified distinct)*
- [x] §5 the two `#[ignore]`d integration tests pass. *(2026-08-20 @ `70ec7d9`, re-run after the piper `--config` fix `4725dd0`)*

Record the run **date + commit** in `todo.md` (the "Final gates" block) when
this passes — that's the Tier-3 sign-off.
