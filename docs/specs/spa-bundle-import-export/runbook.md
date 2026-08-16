# Runbook — SPA ↔ desktop bundle round-trip (Tier-2 smoke test)

> Effort 3, task T10. The `web/src/lib/bundle/parity.test.ts` gate proves the
> SPA reader ingests every Rust fixture the desktop produces. The
> `import`/`export`/writer unit tests prove the IDB seams. This runbook proves
> the one thing no automated test can: **the audio actually plays in a real
> browser after a real export → desktop-synth → import loop.** Tier-2 of the
> off-device track ("close the tab, synth keeps going") is satisfied when this
> run succeeds.

This is a **manual, human-run** end-to-end smoke test (spec §"Testing
strategy" — no e2e/browser test in this effort). Run it once before declaring
effort 3 shipped, and again whenever you touch `web/src/lib/bundle/` (reader,
writer, import, export) or the desktop binary's `synth`/`resynth` handlers.

## Prerequisites

1. **The desktop binary, built.**

   ```
   cargo build -p taletrek-desktop
   ```

2. **`piper` + `ffmpeg` on `PATH`.** `ffmpeg` must be built with `libopus`
   (`-c:a libopus`) — verify with `ffmpeg -version | grep libopus`. See
   effort 2's [`runbook.md`](../desktop-synth-app/runbook.md) §Prerequisites
   for Piper install notes. (The synth step below uses the curated voice's
   auto-download, so you do **not** need a voice model pre-installed.)

3. **The SPA dev server.** In a second terminal:

   ```
   pnpm dev
   ```

   Open the printed URL (<http://localhost:8253>) in a real browser
   (Chrome/Firefox/Safari — the one your users will use).

4. **At least one book in the library.** Any source works: upload an EPUB,
   PDF, or TXT via the library's upload button, **or** pick an existing book.
   For a clean first run, prefer a short book (a few paragraphs) so synth is
   fast.

## 1. Export a text-only bundle from the SPA

1. On the library page, open a book's action menu → **Export bundle**.
2. In the dialog, choose **Text-only** (labelled "Synth elsewhere").
3. A download starts named `<slug>.text.taletrek` — e.g. a book titled
   "Moby Dick" yields `moby-dick.text.taletrek`. Save it somewhere the
   desktop binary can read (e.g. `~/Downloads/` or `/tmp/`).

   > If you instead pick **Full** on a book with no cached audio, the SPA
   > refuses with "This book has no audio to export. Choose text-only
   > instead." — that's the expected guard, not a bug.

## 2. Synth the bundle on the desktop

```
./target/debug/taletrek-desktop synth \
    --input ~/Downloads/moby-dick.text.taletrek \
    --output /tmp/moby-dick.full.taletrek
```

The first run downloads the default curated voice
`en_US-hfc_female-medium` (~63 MiB) into `~/.cache/taletrek/voices/` with
per-integer-percent progress on stderr; subsequent runs hit the cache. When
synth completes you should see a final summary line, e.g.:

```
synth: 3 segments, voice en_US-hfc_female-medium, 1m 02s → /tmp/moby-dick.full.taletrek
```

To synth under a different voice (e.g. `en_US-lessac-medium`, if installed),
pass `--voice`:

```
./target/debug/taletrek-desktop synth \
    --input ~/Downloads/moby-dick.text.taletrek \
    --voice en_US-lessac-medium \
    --output /tmp/moby-dick.full.taletrek
```

> **CLI flags are long-form only** (`--input` / `--voice` / `--output` /
> `--voice-path`). There are no `-i` / `-v` / `-o` short forms.

## 3. Import the full bundle back and play it

1. Back on the SPA library page, click **Import bundle**.
2. In the file picker, select `/tmp/moby-dick.full.taletrek`.
3. A toast reads `Imported "<title>" (with audio)`, and the book appears in
   the library.
4. Open it and press **Play**.

   **This step is the whole point of the runbook** — every other assertion
   is already covered by the parity + import unit tests. You should hear
   clean, continuous speech synthesized by the desktop, with **no
   re-synthesis happening in the browser** (no Piper model fetch, no spinner
   on first paragraph). If playback is silent/garbled, or if the SPA starts
   synthesizing instead of playing the bundled audio, the cross-language
   cache-key contract has drifted — file a bug against
   `web/src/lib/audio-cache.ts` / `tts/normalize.ts` or
   `crates/synth::cache_key`.

Sanity-check the manifest if anything looks off:

```
unzip -p /tmp/moby-dick.full.taletrek manifest.json | python3 -m json.tool
```

Confirm `audio.present` is `true`, `audio.codec` is `"opus"`, and
`audio.segmentCount` matches the distinct-paragraph count.

## 4. Variant — import the same full bundle twice (collision rule)

This proves the new-id-on-collision + content-addressed dedup contract
(spec §"Success criteria").

1. Import `/tmp/moby-dick.full.taletrek` a **second** time via **Import
   bundle**.
2. The library now shows **two** copies of the book (distinct entries,
   distinct ids — never a silent overwrite).
3. Both play.
4. (Optional, advanced) Open DevTools → Application → IndexedDB → the
   `audioCache` store. The paragraph entries are **not** duplicated — the
   second import reused the first import's audio via the shared
   `audioCacheKey(voice, normalizedText)` key. This is the dedup that keeps
   a re-import cheap.

## 5. Variant — export a full bundle, import on a fresh device

Proves a synth'd book travels as a self-contained full bundle.

1. Pick a book that is **already synth'd** in the SPA (on-device Piper, or
   the book you just imported in step 3). Open its action menu → **Export
   bundle** → **Full**. Download `<slug>.full.taletrek`.
2. On a fresh browser profile / device (clear storage first, or use a
   private window): `pnpm dev`, then **Import bundle** → select the full
   bundle.
3. It imports with audio and **plays immediately, offline, no
   re-synthesis** — identical to step 3.

## 6. Backstop — the automated parity gate

Before re-running this runbook by hand after a code change, confirm the
automated backstop still holds (it encodes steps 1–3's contract, minus the
audio-plays check):

```
pnpm test -- bundle      # reader/writer/import/export + parity against the 3 Rust fixtures
cargo test -p taletrek-synth   # fixtures unchanged (effort 1, frozen)
```

`bundle/parity.test.ts` loads the three archives under
`crates/synth/tests/fixtures/` and asserts the SPA reader ingests each. If
that test is red, this runbook will be too — fix the drift first.

## Passing criteria

Effort 3 is smoke-clean when **all** of:

- [ ] Step 1 produces a `<slug>.text.taletrek` download.
- [ ] Step 2 exits 0 and prints the synth summary line.
- [ ] Step 3: the imported full bundle **plays end-to-end offline with no
      re-synthesis** — the load-bearing assertion.
- [ ] Step 4: a second import creates a distinct library book with no
      duplicate `audioCache` entries.
- [ ] Step 5: a full bundle exported then imported on a fresh profile plays
      immediately.
- [ ] `pnpm test -- bundle` and `cargo test -p taletrek-synth` are green.

Record the run (date + commit) in [`todo.md`](./todo.md) under the Phase 5
gates.
