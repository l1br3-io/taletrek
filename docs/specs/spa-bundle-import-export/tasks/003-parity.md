# Task 003: Parity test against the Rust fixtures

**Description:** THE conformance gate (ADR-0013's #1 stated risk: format drift). A single test file that loads the three committed Rust archives by **relative path** (not copied) and proves the TS reader ingests each correctly. If this test fails, the two implementations have drifted. Land it immediately after the reader so the risk is retired before any IDB work is built on top.

**Acceptance criteria:**
- [ ] `web/src/lib/bundle/parity.test.ts` loads, via `path.join(__dirname, '../../../../../crates/synth/tests/fixtures/')`, the three fixtures: `book-text-only.taletrek`, `book-full.taletrek`, `library.taletrek-lib`.
- [ ] `book-text-only.taletrek`: reader returns a `BookBundle` with `manifest.audio.present === false`, a non-empty `chapters` array, and an empty `audio` Map.
- [ ] `book-full.taletrek`: `manifest.audio.present === true`, `codec === "opus"`; every distinct paragraph in `chapters` has a corresponding `audio` entry whose key **exactly equals** `await audioCacheKey(manifest.book.voiceId, paragraphText)` (the parity assertion — Rust and TS key derivation agree).
- [ ] `library.taletrek-lib`: reader throws `UnsupportedBundleKindError` (library bundles not yet supported by the SPA — never crashes).
- [ ] A short header comment in the test explains: fixtures are owned by effort 1 (`crates/synth`); changing them there breaks this test, which is the intended drift signal.
- [ ] Vitest config permits reading files outside `web/` (the relative path crosses the workspace root). If not, configure `server.fs.allow` / test `deps` inline — minimal change, documented in the test header.

**Verification:**
- [ ] `pnpm test -- bundle/parity` green against the **current** committed fixtures (proves Rust↔TS parity holds today).
- [ ] `cargo test -p taletrek-synth` still green (confirms this effort didn't touch the fixtures or the Rust side).

**Dependencies:** T2 (reader). No dependency on the writer — this test only reads.

**Files likely touched:**
- `web/src/lib/bundle/parity.test.ts` (new)
- `web/vitest.config.ts` (only if fs.allow needs widening — otherwise untouched)

**Docs:** The test file's header comment is the documentation; no `gotchas.md` entry unless a cross-workspace fs.allow gotcha emerges (then inline in `vitest.config.ts`).

**Estimated scope:** Small (1 new test file; the load + assertions are compact, the value is the gate itself).
