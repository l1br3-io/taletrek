# Task 001: ADR-0014 — dual-shape SPA amends ADR-0013 alt-2

**Description:** Write the decision record before code: the personal server hosts the *same* SPA build, making it a live API client of the server (same-origin, cookie-authed). This amends ADR-0013's alternative #2 rejection ("live SPA↔server connection — rejected for v1"): the concerns that killed it for v1 (auth, real-time progress, conflict resolution, weakened offline-first) are now addressed — auth + job polling shipped in effort 4, offline-first is preserved because the standalone shape is untouched and hosted mode is deliberately online-only. File-based bundles remain the interchange for desktop/Tier-2. All locked spec decisions (browser-side parsing, client-side AI keys, online-only hosted, no migration) get their permanent home here.

**Acceptance criteria:**
- [ ] `docs/adrs/0014-server-hosted-spa-dual-shape.md` exists following the house ADR format (Context / Decision / Consequences / Alternatives considered), status Accepted, dated 2026-08-25.
- [ ] It explicitly supersedes *the alt-2 rejection in* ADR-0013 (narrowly — not the whole ADR) and states the invariants that survive: parsing stays browser-side, on-device Piper stays in the standalone shape, file-based interchange stays, single-user trust model stays.
- [ ] It records the dual-shape contract: one build, boot-time mode resolution, same-origin only, online-only hosted mode, client-side AI keys.
- [ ] ADR-0013 gets a one-line pointer added to its Status line (or header) noting the amendment by ADR-0014 — no rewriting of its body.

**Verification:**
- [ ] `python3 .opencode/harness/scripts/check-refs.py` (if it covers docs links) or manual link check — every relative link in the new ADR resolves.
- [ ] `git diff --stat` shows only `docs/` changes.

**Dependencies:** None

**Files likely touched:**
- `docs/adrs/0014-server-hosted-spa-dual-shape.md` (new)
- `docs/adrs/0013-off-device-synth-and-portable-bundles.md` (one-line amendment pointer)

**Docs:** This task *is* docs.

**Estimated scope:** Small (1-2 files)
