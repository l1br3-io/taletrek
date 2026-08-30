# T10 — PDF parser (per T2 verdict)

**Description:** The hardest format, built on the T2 spike's validated crates: `pdf-extract` for per-page text → paragraphs, `lopdf` for the `/Outlines` tree → chapter boundaries. ADR-0008 tier-1 only — outline or single chapter, nothing invented. **Checkpoint B** lands here.

**Work:**
- [ ] `src/pdf.rs` — text: per-page extraction, paragraph assembly from layout breaks (spike-informed heuristic for line→paragraph joining; keep it minimal and fixture-pinned); outline: walk `/Outlines`, resolve destinations to page indices, group pages into chapters titled by outline entries (flattened — v1 has no nesting, M10 precedent); zero usable entries (per ADR-0008: `< 2 resolvable`) → single chapter; metadata: Info-dict `Title`/`Author` → fallback `hint` stem
- [ ] Golden tests on both T2 fixtures: `with-outline.pdf` → outline-titled chapters; `no-outline.pdf` → exactly one chapter
- [ ] Idempotence extended; encrypted/scanned PDF → typed error with an honest message (OCR is a non-goal)
- [ ] Deps added per the recorded T2 verdict (swap allowed only there)

**Acceptance:**
- [ ] Both goldens green; page-number lines dropped by the clean seam (fixture includes them)
- [ ] ADR-0008 tier-1 rule encoded in a test comment + assertion (no heuristic path exists to test)

**Verify:** `cargo test -p taletrek-parse --quiet && cargo clippy --workspace --all-targets -- -D warnings`
**Checkpoint B gate:** all six formats parse their goldens — `tests/golden.rs` is the index of record.

**Dependencies:** T2, T3
**Files:** `crates/parse/src/pdf.rs`, `crates/parse/Cargo.toml`, `tests/golden.rs`
**Docs:** ADR-0008 companion link in pdf.rs module docs
**Estimated scope:** M
