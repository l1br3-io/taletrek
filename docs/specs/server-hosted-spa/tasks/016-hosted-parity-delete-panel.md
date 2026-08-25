# Task 016: Hosted UX parity + delete the askama panel

**Description:** Close the UX gap so the hosted SPA is the server's only real UI, then remove the interim askama operator panel (locked decision). Parity items: voice picker from `GET /api/voices`; per-book actions (resynth, delete with 409-running-job handling); job/progress visibility on book cards; mode-conditional affordances — hide local-only surfaces in server mode (bundle import/export buttons, on-device synth toggles, audio-cache budget settings, wake-lock upload UX) and show server ones (logout). `/ui/login` stays.

**Acceptance criteria:**
- [ ] Voice selection in hosted mode lists curated voices (id/name/quality/language) and passes them to synth/resynth.
- [ ] Book cards + detail expose: resync/resynth (voice picker), delete (409 → "job running" message), synth status (in-flight %, failed-with-error, done-while-away).
- [ ] Mode-conditional UI driven solely by the provider's `mode` (no feature-sniffing in components): import/export hidden in server mode; local-only settings sections hidden; logout link shown; login-redirect honored.
- [ ] Askama panel **deleted**: `/ui/admin/*` routes, `ui.rs` handlers, `server/templates/*` (except login), askama dep if login is re-homed (login page may move to a minimal handler/template — keep it no-JS). Router tests updated; security-header tests for `/ui/*` collapse to the login page.
- [ ] `cargo clippy` + `cargo test -p taletrek-server` + `pnpm verify` green.
- [ ] Manual: full hosted session — login → upload → synth → read → resynth to another voice → delete; `/ui/admin` now 404; `/ui/login` still works logged-out.

**Verification:**
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` + `cargo test --workspace` + `pnpm verify` green.
- [ ] Manual walkthrough above.

**Dependencies:** T13, T14, T15

**Files likely touched:**
- `server/src/http/{ui.rs,mod.rs}`, `server/templates/*`, `server/Cargo.toml` (askama if fully removed)
- `web/src/routes/library/*` (cards, actions), `web/src/routes/settings/*` (mode-conditional sections), `web/src/components/*` (import/export visibility, logout)

**Docs:** None expected beyond code comments.

**Estimated scope:** Large (5-8 files) — split "SPA parity items" from "panel deletion" into two commits; both under T16.
