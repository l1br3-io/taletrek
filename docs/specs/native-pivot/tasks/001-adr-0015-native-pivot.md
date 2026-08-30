# T1 — ADR-0015: the pivot decision record

**Description:** Write the decision record *before* any deletion (house rule: decisions precede code). ADR-0015 records the pivot (Rust kernel + native apps + web-as-storefront), points at the locked stack, and enumerates the full deletion list. It supersedes ADR-0014 (deleted with this effort — its subject no longer exists) and narrows ADR-0013 (server tier removed; bundle format + desktop synth survive). Amend ADR-0013's status header to point at 0015 — house precedent (0013 ↔ 0014 did exactly this).

- [x] `docs/adrs/0015-native-pivot-rust-kernel-and-native-apps.md` exists in house format (Context / Decision / Consequences / Alternatives considered), Status: Accepted, dated 2026-08-30, linking the ideas one-pager
- [x] Deletion list in 0015 covers: `server/`, `docs/specs/personal-server/`, `docs/specs/server-hosted-spa/`, `docs/deploy-digitalocean.md`, `docs/off-device-synth-track.md`, and ADR-0014 itself
- [x] ADR-0013 status header amended: server tier superseded by 0015

**Files:** `docs/adrs/0015-*` (new), `docs/adrs/0013-*` (status header only)
**Verify:** file reads cleanly; its links resolve after T2 deletions (0015 links only to surviving files + the ideas doc)
