# Task 009: Docs + gotchas + byte-compat wording fix

**Description:** The documentation pass once the code is stable. (a) Land resolved decision #1 — a small clarification edit to `docs/bundle-format.md` retiring the "byte-compatible archives" wording in favour of "mutual round-trip conformance" (the rule is unchanged; only the wording was over-specified). (b) Record the two v1 gotchas surfaced by this effort. (c) Add the AGENTS.md index lines for any new gotcha entries. (d) Update the ROADMAP effort table if needed (T3 status flip belongs to the merge commit, not here).

**Acceptance criteria:**
- [ ] `docs/bundle-format.md` line 12 + §"Conformance rules" edited: "byte-compatible archives" → "mutual round-trip conformance" with one sentence explaining ZIP impls differ in entry order/compression-level/header timestamps but the conformance rule is read-what-the-other-wrote. The `schemaVersion: 1` format itself is unchanged — this is a wording clarification, not a format change. Note the edit in the file's status line if it has one.
- [ ] `docs/gotchas.md` gains two entries (G27, G28 — next free indices):
  - **G27 — Bundle import is in-memory (jszip); huge full bundles can pressure mobile memory.** v1 loads whole-archive; a streaming reader is the documented follow-on.
  - **G28 — `sourceFormat: "unknown"` maps to `'txt'` on SPA import** (bundle format allows `"unknown"`; SPA `BookFormat` does not). Least-lossy default; note in `import.ts` too.
- [ ] `AGENTS.md` "Critical gotchas" index gets one-line pointers for G27 + G28 linking to `docs/gotchas.md#g27`/`#g28` (index line only, no prose — per the rules).
- [ ] `web/src/lib/bundle/` README not required; the `parity.test.ts` header (T3) + the inline `/** GOTCHA */` comments are the in-tree docs.

**Verification:**
- [ ] `python3 .opencode/harness/scripts/check-refs.py` green (no broken doc links introduced).
- [ ] `pnpm verify` still green (docs-only change, but confirms nothing else drifted).
- [ ] `cargo test -p taletrek-synth` still green (the `bundle-format.md` wording edit must not affect the Rust side; the format is unchanged).

**Dependencies:** Soft on T2–T8 (gotchas should describe the actual code, so write them after the traps are concrete). Can land after T8.

**Files likely touched:**
- `docs/bundle-format.md` (wording edit)
- `docs/gotchas.md` (G27, G28)
- `AGENTS.md` (two index lines)

**Docs:** This task *is* the docs.

**Estimated scope:** Small (3 doc edits; no code).
