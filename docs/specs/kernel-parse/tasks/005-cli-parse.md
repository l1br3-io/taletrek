# T5 — CLI `parse` subcommand + `just parse-fixture`

**Description:** Give the desktop CLI its front door: `taletrek-desktop parse --input book.epub --output book.taletrek`. All fs lives here (read source bytes, write bundle); the crate stays pure. This completes the first vertical slice — **Checkpoint A**.

**Work:**
- [ ] `desktop/src/cli.rs` — `Parse { input, output?, voice? }` variant; `--voice` defaults to the curated `en_US-hfc_female-medium`; update the crate-level `about` (no longer bundle-in only)
- [ ] `desktop/src/main.rs` — parse handler: extension → `SourceFormat` map (`.epub/.txt/.html/.htm/.md/.markdown/.docx/.pdf`; unknown extension → typed error listing supported formats), `std::fs::read` → `parse_source` → `to_text_only_bundle(generator = GENERATOR_APP + version)` → `write_book_bundle_file`; default output `<stem>.taletrek` beside input (`default_parse_output` in `bundle_io.rs`, sibling of the synth/resynth naming)
- [ ] Only `.taletrek` input on `synth`/`resynth` keeps meaning bundle (chain arrives T11)
- [ ] `justfile` — `parse-fixture` recipe mirroring `synth-fixture` (TXT fixture → `/tmp/`), listed under the dev-task docs
- [ ] Tests: cli flag parsing incl. defaults; handler wiring with a stub parser (mock at the `parse_source` seam or via TXT, which is real)

**Acceptance:**
- [ ] `just parse-fixture` writes a `.taletrek` that `read_book_bundle` validates and the web reader imports (manual `pnpm dev` smoke: library shows the book, chapters listed)
- [ ] Unknown extension produces the helpful error, not a panic

**Verify:** `cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --quiet && just parse-fixture` + reader smoke
**Checkpoint A gate:** TXT path is complete end-to-end (bytes → clean chapters → bundle → CLI → importable).

**Dependencies:** T3, T4
**Files:** `desktop/src/{cli,main,bundle_io}.rs`, `justfile`, tests
**Docs:** `docs/developing.md` gains the recipe line if it lists recipes
**Estimated scope:** S
