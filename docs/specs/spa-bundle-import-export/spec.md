---
status: active
started: 2026-08-04
---

# SPEC — Off-device synth track · Effort 3: SPA bundle import/export

> Track ADR: [`docs/adrs/0013-off-device-synth-and-portable-bundles.md`](../../adrs/0013-off-device-synth-and-portable-bundles.md)
> Format spec (frozen v1): [`docs/bundle-format.md`](../../bundle-format.md)
> Foundation: effort 1 [`portable-bundle-format`](../portable-bundle-format/spec.md) (✅ shipped) — owns the format + Rust crate + conformance fixtures. Effort 2 [`desktop-synth-app`](../desktop-synth-app/spec.md) (✅ shipped) — produces `.taletrek` files this effort consumes.
> Third of four efforts: 1. portable-bundle-format (shipped) → 2. desktop-synth-app (shipped) → **3. spa-bundle-import-export (this)** → 4. personal-server.

## Problem

Effort 2 ships a headless Rust CLI that turns a text-only `.taletrek` bundle into a full one (synth'd, Opus audio). That delivers Tier 2 of the off-device track — *only if the SPA can actually exchange these files*. Today the SPA has no code that reads or writes a `.taletrek` archive. The closed loop is: SPA exports a text-only bundle → user runs the desktop app → SPA imports the full bundle back and plays it. Without both ends in the SPA, the desktop binary is an island and Tier 2 ("close the tab, synth keeps going") is unreachable from the product.

This effort is **the SPA's only new surface** for the off-device track (ADR-0013). It adds no server, no parsing, no synthesis. It reads + writes the frozen v1 bundle format, ingesting into and exporting from the SPA's existing IndexedDB stores. Everything the desktop produced must play in the SPA; everything the SPA can export must re-synth cleanly on the desktop.

## Scope (this effort only)

**In scope:**

- A TS reader + writer for **book bundles** (`*.taletrek`, `kind: "book"`), conforming to `docs/bundle-format.md` v1.
- Import: a `.taletrek` file (text-only **or** full) → ingest into the SPA's existing IDB stores (`books`, `chapters`, `audioCache`, `files`-provenance) so it becomes a first-class library book that plays immediately.
- Export: a library book → a `.taletrek` file (text-only **or** full) written to disk via a download.
- Round-trip of all three optional `meta/*` entries (`source.json`, `processing.json`, `position.json`).
- Library-page UI: a per-book "Export bundle" action and a library-level "Import bundle" button.
- A conformance/parity test against the committed Rust fixtures (`crates/synth/tests/fixtures/`).

**Out of scope (deferred):**

- **Library bundles** (`*.taletrek-lib`, `kind: "library"`). Reader **detects and refuses** one with a typed `UnsupportedBundleError` pointing at "library bundles are not yet supported by the SPA" — never crashes. Full library import/export is a follow-on.
- Changing the bundle format. `schemaVersion: 1` is an input, not an output of this effort.
- New audio codecs. Reader accepts Opus + M4A (+ WAV); writer emits Opus.
- Raw-file parsing on the bundle path. `text.json` is already cleaned; the SPA ingests it verbatim.
- Any server connection. File-based interchange only (ADR-0013 invariant).
- On-device Piper / offline-first path. Untouched.

## Objective & users

**Users:** existing SPA users who also run the desktop app (T2) or received a `.taletrek` from elsewhere. No accounts, no network. The loop must close entirely with file picks + downloads.

**Success looks like:**

1. Export a text-only bundle from any library book → run `taletrek-desktop synth` on it → import the full result back → it plays end-to-end in the SPA, offline, with no re-synthesis.
2. Import a full bundle the desktop produced → it appears in the library, audio already populated via content-addressed dedup into `audioCache`, plays immediately.
3. Reading position, AI-transform provenance, and source-file metadata survive a round-trip (export → desktop → import).
4. Re-importing the same bundle is safe: it creates a second book with a fresh id (per `bundle-format.md` §Conformance), never silently overwrites.

## Conformance (the load-bearing requirement)

ADR-0013's primary stated cost is *"format drift risk"* between the Rust and TS implementations. This effort owns the TS side of that gate. Two rules:

1. **Mutual round-trip, not byte-identity.** The format doc's phrase "byte-compatible archives" is interpreted here as: the TS reader loads every Rust-produced fixture unchanged, and the Rust reader loads every TS-produced archive unchanged. True byte-identity across ZIP implementations (entry order, compression-level quirks, header timestamps) is not achievable without pinning implementation details that hurt both sides; it is explicitly **not** a success criterion. *(Flagged in Open Questions — may warrant an ADR addendum to `bundle-format.md` to retire the "byte-compatible" wording.)*
2. **Fixtures are shared.** The three committed archives live at `crates/synth/tests/fixtures/{book-full,book-text-only,library}.taletrek(-lib)`. The TS parity test imports them by relative path — it does **not** copy them. A fixture change on the Rust side must break the TS test (and vice versa).

## Commands

```
pnpm install              # install web/ deps (jszip already present)
pnpm dev                  # Vite dev server — exercise import/export UI live
pnpm build                # production build → web/dist
pnpm typecheck            # tsc --noEmit
pnpm lint                 # biome check
pnpm test                 # vitest run (includes bundle parity + import/export tests)
pnpm test -- bundle       # run only bundle-layer tests
pnpm verify               # lint + typecheck + test + build (gate before commits)
```

No new CLI. No Rust touched in this effort (`crates/synth` + `desktop/` are frozen inputs).

## Project structure

New code lives under `web/src/lib/bundle/`. The shape mirrors the existing `web/src/lib/backup.ts` precedent (top-level portability feature) but modularised because reader/writer/import/export/errors are each substantial.

```
web/src/lib/bundle/
  manifest.ts          # TS mirror of manifest.json + text.json + meta/* shapes; schemaVersion guard
  errors.ts            # Typed error hierarchy (see Code style)
  reader.ts            # .taletrek bytes → in-memory BookBundle (jszip unzip + JSON parse + validate)
  writer.ts            # BookBundle → .taletrek bytes (jszip deflate, Opus codec)
  import.ts            # reader output → IDB ingest (new-id-on-collision; audio → audioCache)
  export.ts            # IDB → BookBundle (collect chapters + audio + meta; resolve voice)
  fixtures/            # gitignored except a README pointing at crates/synth/tests/fixtures/
  reader.test.ts       # reads Rust fixtures; refuses unknown schemaVersion; accepts text-only + full
  writer.test.ts       # round-trips through reader; Opus default; manifest correctness
  import.test.ts       # fake-indexeddb: new-id-on-collision; audio dedup; meta/* persisted
  export.test.ts       # fake-indexeddb: voice recovery; text-only vs full selection
  parity.test.ts       # THE gate: loads the 3 Rust fixtures; asserts SPA can read desktop output

web/src/components/
  BundleImportButton.tsx   # library-level button → file picker (.taletrek) → import.ts → toast
  BundleExportAction.tsx   # per-book menu item → export.ts → download link
  (both wired into the existing Library route)

web/src/routes/
  ... (existing Library route gains the two components above; no new route)
```

**No new IDB store.** Imported audio flows into the existing `audioCache` store (content-addressed key == bundle's `<cache-key>` entry name → automatic dedup with on-device-synth'd audio). Imported books/chapters go into the existing `books` / `chapters` stores. Provenance/position/processing ride on `Book` fields that already exist (`position`, `progressFraction`, `processing`) plus `meta/source.json` round-tripped via the `files` store.

## Code style

Strict TS, branded IDs, interfaces-before-impl, container/presentational split, variant types for async — all per `AGENTS.md`. Co-located `*.test.ts`. No comments unless asked.

The defining convention for this effort is the **typed-error hierarchy** (mirrors `desktop/src/bundle_io.rs::BundleIoError` and `web/src/lib/backup.ts::CorruptBackupError`):

```ts
// web/src/lib/bundle/errors.ts
import type { AudioCodec, ManifestSchemaVersion } from './manifest'

/** Base for every bundle failure. `name` is the discriminator at the UI boundary. */
export abstract class BundleError extends Error {
  override readonly name = 'BundleError'
}

/** `schemaVersion` is missing or not a known major. Reader MUST refuse, not best-effort load. */
export class UnsupportedSchemaVersionError extends BundleError {
  override readonly name = 'UnsupportedSchemaVersionError'
  constructor(readonly found: number, readonly supported: readonly ManifestSchemaVersion[]) {
    super(`Bundle schemaVersion ${found} is unsupported (this SPA understands ${supported.join(', ')})`)
  }
}

/** The archive is not a ZIP, is truncated, or is missing a required entry (manifest.json / text.json). */
export class CorruptBundleError extends BundleError {
  override readonly name = 'CorruptBundleError'
  constructor(reason: string) {
    super(`Bundle is corrupt: ${reason}`)
  }
}

/** `kind` is present but not `"book"` — covers the `.taletrek-lib` (library) refusal. */
export class UnsupportedBundleKindError extends BundleError {
  override readonly name = 'UnsupportedBundleKindError'
  constructor(readonly found: string) {
    super(`This bundle has kind="${found}" and is not supported by the SPA (library bundles are not yet supported)`)
  }
}

/** Audio codec in the manifest is one the SPA cannot play. */
export class UnsupportedAudioCodecError extends BundleError {
  override readonly name = 'UnsupportedAudioCodecError'
  constructor(readonly found: string) {
    super(`Bundle audio codec "${found}" is not playable in this SPA`)
  }
}
```

Import wiring surfaces these as user-facing toasts (`CorruptBundleError` → "This file isn't a TaleTrek bundle"; `UnsupportedBundleKindError` → "Library bundles aren't supported yet"; etc.). The hierarchy is the API contract between the `bundle/` layer and the UI — no `unknown` / `any` at the seam.

## Testing strategy

Vitest + Testing Library + `fake-indexeddb`, all co-located (`*.test.ts`), per `AGENTS.md`. Four test layers:

1. **Unit (reader/writer):** synthetic in-memory bundles → `writer` → `reader` round-trip; manifest field correctness; refusal paths (`UnsupportedSchemaVersionError` on `schemaVersion: 2`, `CorruptBundleError` on truncated ZIP, `UnsupportedBundleKindError` on `kind: "library"`).
2. **Conformance / parity (`parity.test.ts`):** the load-bearing test. Loads the three Rust fixtures by relative path (`../../../../../crates/synth/tests/fixtures/`) and asserts the SPA reader ingests each: text-only → chapters present, audio absent; full → audio map keyed exactly by `audioCacheKey(voice, text)` for every paragraph; library → refused with `UnsupportedBundleKindError`. This test failing means the two implementations drifted.
3. **Import/export against `fake-indexeddb`:** new-id-on-collision (import same bundle twice → two books, distinct `BookId`s, both playable); audio dedup (import a full bundle whose paragraphs already exist under the same voice in `audioCache` → no duplicate writes, no size growth); `meta/*` survives (`position` lands on `Book.position`, `processing` on `Book.processing`, `source` on the `files` store); voice recovery on export (from `AudioCacheRecord.voiceId`).
4. **UI (Testing Library):** the import button opens a file picker accepting `.taletrek`; the export action produces a download with the right default filename. No real ZIP I/O at this layer — `import.ts`/`export.ts` are mocked.

No e2e/browser test in this effort. Manual end-to-end (real desktop round-trip) is a runbook step, mirroring effort 2's `runbook.md`.

**Coverage expectation:** the `bundle/` layer aims for full line coverage of the reader's validation branches and the importer's collision/dedup paths; the UI components need only cover happy + one error toast.

## Boundaries

**Always do:**
- Run `pnpm verify` before commits (lint + typecheck + test + build).
- Keep `web/src/lib/bundle/` pure-ish: reader/writer take bytes, import/export own the IDB seams. No IDB inside reader/writer — that's what makes the parity test fast and the layers swappable.
- Reuse `audioCacheKey` / `NORM_VERSION` / `normalizeForSpeech` from `web/src/lib/audio-cache.ts` + `tts/normalize.ts` — never re-derive the cache key. Parity depends on a single key derivation.
- Allocate fresh ids via `newBookId()` / `newChapterId()` from `web/src/types.ts` on collision.
- Refuse unknown `schemaVersion` with `UnsupportedSchemaVersionError`. Never best-effort load.
- Map bundle `sourceFormat: "unknown"` → SPA `BookFormat` `'txt'` on import (SPA type has no `"unknown"`; `'txt'` is the least-lossy default). Note in `gotchas.md` if it ever causes confusion.

**Ask first:**
- Adding any new dependency. (`jszip` is already present — reuse it; do **not** add `fflate` without sign-off.)
- Changing an IDB store schema or adding a new store. (Not expected; everything lands in existing stores.)
- Editing `crates/synth/tests/fixtures/` (owned by effort 1; changes there break this effort's parity test and need a paired Rust + TS commit).
- Editing `docs/bundle-format.md` (frozen v1; an ADR addendum is the only way to change it).

**Never do:**
- Synthesize, parse raw files, or contact a server on the bundle path. The bundle path is I/O + JSON + IDB only.
- Change `schemaVersion` or invent new manifest fields.
- Overwrite an existing book on import (always allocate a new id — `bundle-format.md` §Conformance).
- Add a non-Opus writer codec in this effort (reader accepts Opus + M4A + WAV; writer is Opus-only for v1).
- Commit a fixture copy. Fixtures are referenced from `crates/synth/tests/fixtures/` by path.

## Success criteria (testable)

- [x] `parity.test.ts` loads all 3 Rust fixtures; the two book fixtures import cleanly, the library fixture is refused with `UnsupportedBundleKindError`.
- [x] Reader refuses a synthetic `schemaVersion: 2` archive with `UnsupportedSchemaVersionError`.
- [x] Reader accepts a text-only bundle (`audio.present === false` **and** missing `audio/`) — both absence shapes per format doc.
- [x] Import of a full bundle writes one `audioCache` entry per distinct paragraph, keyed exactly by `audioCacheKey(voice, normalizedText)`; re-import of the same bundle creates a second book (new `BookId`) with **zero** new `audioCache` writes (content-addressed dedup).
- [x] Export of a book with cached audio produces a bundle whose `manifest.audio.present === true`, `codec === "opus"`, and `segmentCount` matches the distinct-paragraph count.
- [x] Export of a book with no cached audio produces a text-only bundle (`audio.present === false`, no `audio/` entries).
- [x] `meta/{source,processing,position}.json` survive export → (desktop noop) → import; `position` lands on `Book.position`, `processing` on `Book.processing`, source provenance on the `files` store.
- [x] Library page shows a working "Import bundle" button (accepts `.taletrek`) and a per-book "Export bundle" action producing a download.
- [x] `pnpm verify` green; `cargo test -p taletrek-synth` still green (untouched, but confirms fixtures unchanged). _— `cargo test -p taletrek-synth` green; `pnpm typecheck`/`test`(1113)/`build` green. `pnpm verify` blocked at the `lint` step by a pre-existing failure on `main` (`pool.test.ts`, byte-identical on this branch); `bundle/` is lint-clean. Recorded in `todo.md` Phase 5 gates._
- [ ] Runbook entry: real SPA-export → `taletrek-desktop synth` → SPA-import round-trip produces a playable book on a real browser. _— **Deferred**: human-run walkthrough; `runbook.md` drafted, awaiting a real-browser run (see `todo.md`). Not flippable inside `/build`._

## Resolved decisions (from spec review)

1. **"Byte-compatible archives" → mutual round-trip.** The format doc (line 12) says Rust + TS "must produce byte-compatible archives." Interpreted as **mutual round-trip, not byte-identity** (ZIP implementations differ in entry order, compression-level quirks, and header timestamps; pinning those hurts both sides for no real gain). A small clarification edit to `bundle-format.md` retires the "byte-compatible" wording in favour of "mutual round-trip conformance" — landed as a task in this effort (not a format change; the conformance *rule* is unchanged, only the wording).
2. **Export-when-voice-unknown → refuse full, allow text-only with default voice.** A book with no `audioCache` entries and no `uploadJob` has no recoverable voice. `manifest.book.voiceId` is required, so: **refuse full export** with a clear "no audio to export" error; **allow text-only export** stamped with the user's current default voice from settings (so the desktop can still synth it). Implemented in `export.ts`.
3. **Import size guard → yes, mirror `BackupTooLargeError`.** Pre-flight `navigator.storage.estimate()` against the bundle's uncompressed size; throw `BundleTooLargeError` (sibling of `BackupTooLargeError`) on insufficient quota. Implemented in `import.ts`.
4. **Streaming vs in-memory → in-memory for v1.** jszip loads the whole archive into memory. Simplest, matches `backup.ts`. Mobile memory pressure on huge full bundles is a **known v1 limitation** → recorded as a gotcha; a streaming reader is a follow-on if it bites in real testing.

## Follow-on efforts (not this one)

- Effort 4 — `personal-server` (Rust Docker library server + worker-mode synth).
- Library-bundle (`.taletrek-lib`) SPA support — natural follow-on once book-level UX proves out.
