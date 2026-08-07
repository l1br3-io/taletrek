# Runbook — Testing the SPA ↔ desktop bundle round-trip

> **New here?** This guide walks you through manually verifying TaleTrek's
> *off-device synth* feature end-to-end, from a fresh clone, with no prior
> context. Every step lists the **exact** button label and the **expected**
> result. Pick a tier below and follow it straight through.
>
> **What this proves:** the Tier-2 loop — *export a book from the SPA →
> synthesize it on a desktop → import it back → it plays offline with no
> re-synthesis.* The automated tests prove the contract; **this runbook proves
> the audio actually plays**, which is the one assertion a test can't make.

The feature lives in `web/src/lib/bundle/` (SPA reader/writer/import/export)
consuming `.taletrek` archives the desktop app produces. Spec:
[`spec.md`](./spec.md). Format: [`../../bundle-format.md`](../../bundle-format.md).

---

## Pick a path

You don't have to do all three. Each tier is a self-contained verification —
stop wherever your confidence is met.

| Tier | What it proves                          | Setup needed                          | Time    |
| ---- | --------------------------------------- | ------------------------------------- | ------- |
| **A** | The contract: SPA reads desktop output, no regressions | Node + pnpm only (no hardware)        | ~2 min  |
| **B** | Import → **plays**, export works, refusal + collision correct — against **real desktop-produced** bytes | Node + pnpm + a browser (**no Piper/ffmpeg**) | ~5 min  |
| **C** | The complete loop: export → desktop synth → import → plays | Node + pnpm + `piper` + `ffmpeg` (libopus) | ~15 min |

**Most people should do A then B.** That covers ~95% of confidence with zero
external toolchain. C is the full manual loop for when you've changed the
desktop synth path or want the definitive end-to-end check.

---

## One-time setup

**Prerequisites:** Node 24, pnpm 10.31.0.

```sh
git clone <repo> && cd taletrek
pnpm install          # installs web/ deps (jszip is already included)
pnpm dev              # starts the Vite dev server
```

Open the printed URL — **http://localhost:5173/**. You'll land on a marketing
page. Click **Library** in the top nav (or go straight to
<http://localhost:5173/library>).

The Library page has two controls at the top:
- **Upload a book** — bring your own EPUB/PDF/MOBI/TXT/Markdown.
- **Import bundle** — pick a `.taletrek` archive (this feature).

A brand-new browser profile shows an empty library
(*"Your library is empty. Upload a book to start reading."*). That's expected —
Tier B imports a ready-made book, so you don't need to upload anything.

---

## Tier A — Automated gates (~2 min, no hardware)

Re-runs exactly what CI runs. Proves the **contract** (SPA ingests every Rust
fixture) and that nothing regressed. **Does not prove audio plays** — that's
Tier B.

```sh
pnpm verify                 # lint + typecheck + 1113 tests + production build
pnpm test -- bundle         # focused: reader/writer/import/export + the parity gate
cargo test -p taletrek-synth   # Rust side (effort 1; the fixtures this SPA reads)
```

**What "green" means here:**
- `pnpm verify` exits 0 → the whole web app compiles, lints, and builds.
- `bundle/parity.test.ts` (inside the run above) loads the **three committed
  archives** under `crates/synth/tests/fixtures/` and asserts the SPA reader
  ingests each: text-only → chapters, no audio; full → every paragraph's
  SPA-derived cache key matches an embedded audio entry; library → refused.
  **If this is red, Tier B/C will fail too** — fix the drift first.

✅ **Pass:** all three commands exit 0.

---

## Tier B — Browser smoke test, no synth toolchain (~5 min) · **recommended**

The committed fixture `crates/synth/tests/fixtures/book-full.taletrek` **is
real output from the Rust synth crate** — so importing it tests the genuine
loop without you needing Piper, ffmpeg, or a desktop build.

Make sure the dev server is running (`pnpm dev`) and you're on
<http://localhost:5173/library>.

### B1. Import a full bundle

1. Click **Import bundle** (next to *Upload a book*).
2. In the file picker, select
   `crates/synth/tests/fixtures/book-full.taletrek`.
3. **Expected:** a status line appears reading `Importing…`, then becomes
   `Imported "Sample Book" (with audio)`. A book card labelled **Sample Book**
   appears in the library with an **Open Sample Book** button, a **More
   actions** (⋯) menu, and a `0% read` progress bar.

> If you instead see an error toast, jump to **Troubleshooting** below.

### B2. Play it (the load-bearing step)

1. Click **Open Sample Book**.
2. Press **Play**.

**Expected:** you hear clean, continuous speech — a reading of the fixture's
text. There is **no model download, no spinner, no "synthesizing…"** — the
audio came straight out of the bundle. ✅ **If you hear it, this whole feature
is verified**; the remaining steps are bonus confidence.

> Pressing Play is the one assertion only a human can make (you have to
> *hear* it). Everything else in this runbook is automatable and already
> covered by tests; this single step is why the runbook exists.

### B3. Export a text-only bundle

1. Back on the Library page, open the **More actions** (⋯) menu on the
   Sample Book card.
2. Click **Export bundle for Sample Book**.
3. A modal titled **Export bundle** opens with two choices:
   - **Text-only** — *Synth elsewhere*
   - **Full** — *Includes audio*
4. Click **Text-only**.
5. **Expected:** status reads `Downloaded sample-book.text.taletrek` and a
   **Done** button appears. A file `sample-book.text.taletrek` is saved to
   your default download folder. (The filename is `<slug>.<kind>.taletrek`
   where `<slug>` is the lowercase, hyphen-separated title and `<kind>` is
   `text` or `full`.)

Sanity-check the manifest if you like:

```sh
unzip -p ~/Downloads/sample-book.text.taletrek manifest.json | python3 -m json.tool
# expect: "audio": { "present": false }   (no audio entries in a text-only bundle)
```

> **Full** on a book that *has* audio (like Sample Book) works too and
> produces `sample-book.full.taletrek`. **Full** on a book with *no* cached
> audio is refused with *"This book has no audio to export. Choose text-only
> instead."* — that's the expected guard.

### B4. Library bundles are refused (not crashed)

1. Click **Import bundle** again.
2. Select `crates/synth/tests/fixtures/library.taletrek-lib`.
3. **Expected:** a red alert `Library bundles aren't supported yet`, and **no**
   new book appears. (Library bundles — `kind: "library"` — are detected and
   refused; full library import/export is a future effort.)

### B5. Re-importing the same bundle is safe (collision rule)

1. Click **Import bundle** and select `book-full.taletrek` **again** (the same
   file as B1).
2. **Expected:** `Imported "Sample Book" (with audio)` again, and the library
   now shows **two** Sample Book cards (distinct books, distinct ids — never a
   silent overwrite). Both open and play.

This is the content-addressed-dedup contract: the second import reuses the
first import's audio (no duplicate work, no duplicate storage).

✅ **Tier B pass:** B1 imports, B2 plays, B3 downloads, B4 refuses, B5 creates
a second book.

---

## Tier C — Full Tier-2 loop with desktop synth (~15 min)

The complete round-trip: export a *text-only* bundle from a real book,
synthesize it on the desktop, import the *full* result back, and play it.
Use this when you've changed the desktop synth path or want the definitive
end-to-end check.

### C0. Prerequisites (desktop side)

1. **`piper` on `PATH`** — install from
   <https://github.com/rhasspy/piper/releases> (prebuilt) or build from source.
   Verify: `piper --help` prints usage.
2. **`ffmpeg` on `PATH`, built with `libopus`** — verify:
   `ffmpeg -version | grep libopus` (most distro builds include it).
3. **Build the desktop binary once:**
   ```sh
   cargo build -p taletrek-desktop
   ```
   You do **not** need to pre-download a voice — `synth` auto-downloads the
   default curated voice on first run.

> **CLI flags are long-form only** (`--input` / `--voice` / `--output` /
> `--voice-path`). There are no `-i` / `-v` / `-o` short forms.

### C1. Export a text-only bundle from the SPA

1. In the Library, pick any book (upload one if your library is empty). Open
   its **More actions** (⋯) menu → **Export bundle for <title>** →
   **Text-only**.
2. A file `<slug>.text.taletrek` downloads (e.g. `moby-dick.text.taletrek`).

### C2. Synthesize it on the desktop

```sh
./target/debug/taletrek-desktop synth \
    --input ~/Downloads/moby-dick.text.taletrek \
    --output /tmp/moby-dick.full.taletrek
```

- **First run** downloads the default voice `en_US-hfc_female-medium`
  (~63 MiB) into `~/.cache/taletrek/voices/` with percent progress on stderr;
  later runs hit the cache.
- On success, a final summary line prints, e.g.:
  `synth: 3 segments, voice en_US-hfc_female-medium, 1m 02s → /tmp/moby-dick.full.taletrek`
- **Different voice** (if installed): add `--voice en_US-lessac-medium`.

### C3. Import the full bundle back and play

1. Back in the SPA Library, **Import bundle** → select
   `/tmp/moby-dick.full.taletrek`.
2. **Expected:** `Imported "<title>" (with audio)`, book appears.
3. Open it → **Play** → hear the synthesized speech, **no re-synthesis** in the
   browser.

✅ **Tier C pass:** C2 prints the summary line; C3 imports and plays offline.

### C4. Optional — re-voice the bundle (`resynth`)

```sh
./target/debug/taletrek-desktop resynth \
    --input /tmp/moby-dick.full.taletrek \
    --voice en_US-ryan-medium \
    --output /tmp/moby-dick.ryan.taletrek
```

Re-import the result; the new bundle's `book.voiceId` is the new voice, segment
count is unchanged, and a freshly-extracted segment plays with the new timbre.

---

## Troubleshooting

**Import shows an error toast instead of "Imported …":**

| Toast text                                  | Meaning                                                                 |
| ------------------------------------------- | ----------------------------------------------------------------------- |
| `This file isn't a TaleTrek bundle`         | Not a ZIP, truncated, or missing `manifest.json`/`text.json`.           |
| `This bundle is from a newer TaleTrek — upgrade the app` | `schemaVersion` is newer than the SPA understands (`UnsupportedSchemaVersionError`). |
| `Library bundles aren't supported yet`      | It's a `.taletrek-lib` (`kind: "library"`) — by design; not a crash.     |
| `Not enough storage to import this bundle.` | IDB quota pre-flight failed (`BundleTooLargeError`). Free space/retry.   |

**Play re-synthesizes instead of playing bundled audio:** the cross-language
cache-key contract has drifted. File a bug against
`web/src/lib/audio-cache.ts` / `web/src/lib/tts/normalize.ts` or
`crates/synth::cache_key`. (The `bundle/parity.test.ts` gate usually catches
this first — re-run Tier A.)

**Desktop synth errors:**
- `no platform cache directory discovered` → set `$HOME` or pass `--voice-path`
  to point at a local `.onnx` model.
- `piper`/`ffmpeg` not found → ensure they're on `PATH`, or override with
  `--piper <bin>` / `--ffmpeg <bin>`.

---

## Passing criteria (copy into the PR / ship checklist)

Effort 3 is smoke-clean when **all** of:
- [ ] Tier A: `pnpm verify`, `pnpm test -- bundle`, `cargo test -p taletrek-synth` all green.
- [ ] Tier B1: full-bundle import shows the `Imported "Sample Book" (with audio)` toast + card.
- [ ] Tier B2: **Play produces audible speech with no re-synthesis** (the load-bearing check).
- [ ] Tier B3: text-only export downloads `<slug>.text.taletrek`.
- [ ] Tier B4: `.taletrek-lib` refused with the correct toast.
- [ ] Tier B5: re-import creates a second, distinct, playable book.
- [ ] (If run) Tier C: desktop `synth` summary line prints; the re-imported full bundle plays offline.

Record the run (date + commit) in [`todo.md`](./todo.md) under Phase 5.

---

## Reference

- Spec: [`spec.md`](./spec.md) · Plan: [`plan.md`](./plan.md) · Track overview: [`../../off-device-synth-track.md`](../../off-device-synth-track.md)
- Bundle format (frozen v1): [`../../bundle-format.md`](../../bundle-format.md)
- Track ADR: [`../../adrs/0013-off-device-synth-and-portable-bundles.md`](../../adrs/0013-off-device-synth-and-portable-bundles.md)
- Desktop-synth runbook (Piper/ffmpeg install, voice setup): [`../desktop-synth-app/runbook.md`](../desktop-synth-app/runbook.md)
- Test fixtures (shared with the Rust crate): [`../../../crates/synth/tests/fixtures/`](../../../crates/synth/tests/fixtures/)
