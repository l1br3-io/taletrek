# T2 — PDF spike: fixture provenance + `pdf-extract`/`lopdf` verdict

**Description:** De-risk the hardest format *before* building on it (spec R1). Decide how PDF fixtures are produced, commit two of them (with/without `/Outlines`), and validate that `pdf-extract` (text) + `lopdf` (outline) can actually read both. Records a go/swap verdict — throwaway spike code, no production parser.

**Work:**
- [ ] Decide fixture provenance: hand-written minimal PDFs vs generated-then-committed (prefer smallest committable binary that exercises multi-page text + an `/Outlines` tree with resolvable destinations)
- [ ] Commit `testdata/with-outline.pdf` + `testdata/no-outline.pdf`
- [ ] Spike (in `/tmp/opencode` or a `#[ignore]`d scratch test, not shipped code): open both with `pdf-extract` → extract per-page text; open `with-outline.pdf` with `lopdf` → walk `/Outlines` → resolve destinations to page indices
- [ ] Record verdict in this file: crate names + versions, quality of extracted text, outline API usability. If either crate is unusable, propose the swap (ask-first per spec boundaries) and stop

**Acceptance:**
- [ ] Two fixtures committed and byte-stable
- [ ] Verdict recorded below: go / swap-what-for-why
- [ ] `cargo test --workspace --quiet` still green (spike leaves no crate code behind unless it's the real T10 start)

**Verify:** `cargo test --workspace --quiet` + the recorded spike transcript (commands + key output pasted into this file)

**Dependencies:** T1 (fixture dir + SourceFormat exist; spike may also run standalone in /tmp)
**Files:** `crates/parse/testdata/{with-outline,no-outline}.pdf`, this file (verdict)
**Docs:** verdict feeds T10 + resolves the spec's open question on fixture provenance
**Estimated scope:** S

## Verdict (fill in during the spike)

- Fixture provenance: _TBD_
- `pdf-extract` @ _TBD_: _TBD_
- `lopdf` @ _TBD_: _TBD_
- Decision: _TBD_
