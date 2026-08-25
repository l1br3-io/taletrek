# Task 010: `GET /api/books/:id/audio/:contentKey` — OGG/Opus from the stored bundle

**Description:** The playback API: hosted reading fetches one paragraph's audio by its content-addressed key (`${voice}:${NORM_VERSION}:${sha256(...)}` — same scheme both sides by construction). Read the entry out of the stored bundle zip (central-directory lookup, no full unzip), serve buffered with `audio/ogg`. Per-book v1 — no cross-book store, no Range.

**Acceptance criteria:**
- [ ] Protected route `GET /api/books/:id/audio/:contentKey` (path param must accept the full key including colons — verify axum param capture handles `:`; encode/decode rules documented in the handler).
- [ ] Handler (spawn_blocking): open `library/<id>/bundle.taletrek`, locate `audio/<contentKey>.opus` via the zip central directory, read that one entry, return `200` `audio/ogg` + nosniff. Unknown book → `404`; known book, missing key → `404` (or `204`-with-reason if the SPA prefers — pick `404`, document).
- [ ] Entry-name validation: reject path-traversal-shaped keys (`..`, `/`, NUL) with `400` before touching the FS-backed zip.
- [ ] Buffered response is acceptable (paragraphs are tens of KB — note the ceiling in a `/** GOTCHA */`); decompression caps from effort-4 hardening respected.
- [ ] Tests (in-process, synth fixture with audio — generate via stub encoder per existing server test patterns): hit for a known key returns `OggS` magic + `audio/ogg`; unknown key/book → 404; traversal key → 400; auth required.

**Verification:**
- [ ] `cargo clippy` + `cargo test -p taletrek-server` green.
- [ ] Manual curl against the runbook-synthesized bundle: `curl -H "Auth..." .../audio/<key> | file -` → Ogg data.

**Dependencies:** None (T8 parallel-friendly; T9 unrelated)

**Files likely touched:**
- `server/src/http/audio.rs` (new)
- `server/src/http/mod.rs` (route)
- `server/src/store.rs` (zip-entry read helper if not already exposed via `crates/synth`)

**Docs:** Colon-in-path-param gotcha → inline `/** GOTCHA */` in the handler; gotchas.md only if it can't live in code.

**Estimated scope:** Small-Medium (2-3 files)
