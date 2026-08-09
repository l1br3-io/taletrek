# Task 011: Server-rendered HTML UI (askama: index, book, jobs)

**Description:** The minimal operator UI the server serves at `/` and `/ui/*` — browse the library, upload a bundle, trigger synth/resynth per book, and view recent jobs. Server-rendered HTML via `askama` (typed, compiled templates); no JS framework, no build step. This is **not** the product surface (the SPA is) — it's the self-hoster's control panel, mirroring the JSON API 1:1. Authed like the rest of `/api`.

**Acceptance criteria:**
- [ ] `server/Cargo.toml` adds `askama` (with a build step / `askama_axum` for `IntoResponse`).
- [ ] `server/src/http/ui.rs` serves:
  - `GET /` (and `GET /ui/`) → index page: library table (title, author, voice, audio-present badge, actions), an upload `<form enctype="multipart/form-data">`, and a recent-jobs panel.
  - `GET /ui/books/:id` → book detail: metadata + a synth `<form>` (voice `<select>` populated from `worker::voices::CURATED_VOICES`, default `DEFAULT_VOICE_ID`) + a resynth `<form>` (voice required) + a download link + a delete `<form>`.
  - `GET /ui/jobs` → jobs list (status, kind, voice, done/total, error).
- [ ] Templates live under `server/src/templates/` (askama): `index.html`, `book.html`, `jobs.html`, plus a base `_layout.html` (doctype, a `<form>`-friendly minimal CSS — no external assets; inline `<style>` so the image is self-contained).
- [ ] All UI routes sit behind T7's auth layer. The upload/synth/resynth/delete forms POST to the JSON API endpoints (T8/T9/T10) and redirect back to the referring page (Post/Redirect/Get) — no client JS needed beyond a plain submit. The token is supplied via the session/cookie or, for v1 simplicity, the UI is served only on loopback/`TALETREK_UI_TOKEN` — pick the simplest authed option and document it (e.g. a `?token=` query is insecure; prefer a cookie set on first authenticated request, or accept that the UI requires the same bearer header and document the curl/extension workaround).
- [ ] The voice `<select>` for synth/resynth is generated from `CURATED_VOICES` so the UI and the API never disagree on the catalog.

**Verification:**
- [ ] `cargo build` + `cargo clippy -p taletrek-server --all-targets -- -D warnings` clean (askama templates compile at build time — a syntax error fails the build).
- [ ] `cargo test -p taletrek-server` green: render each template with stub data and assert key substrings (a seeded book's title appears in `index.html`; a job's status appears in `jobs.html`) — askama templates are testable as plain render fns.
- [ ] Manual (browser, server running with a token):
  - [ ] `GET /` without auth → `401`; with auth → the library page renders.
  - [ ] Upload `book-text-only.taletrek` via the form → it appears in the table → click into it → synth form → submit → redirect to the book page / jobs panel → poll shows `succeeded` → the book's badge flips to "audio present" → download link returns the bundle.
  - [ ] Resynth form with a different voice → job runs → voice column updates.
  - [ ] No external network requests (inline CSS, no CDN) — `view-source` confirms self-contained markup.

**Dependencies:** T7 (auth + router), T8 (upload/download/delete), T9 (synth), T10 (resynth + voices catalog).

**Files likely touched:**
- `server/src/http/ui.rs` (new — handlers)
- `server/src/http/mod.rs` (route `/` + `/ui/*`, behind auth)
- `server/src/templates/{_layout,index,book,jobs}.html` (new — askama)
- `server/Cargo.toml` (`askama` / `askama_axum`)

**Docs:** A `/** GOTCHA */` on the UI-auth tradeoff (bearer token + browser forms is awkward) and the chosen v1 resolution. Inline-CSS-only decision documented in the layout template.

**Estimated scope:** Medium (4 templates + 3 handlers; no logic complexity, the askama wiring + auth-on-forms is the only fiddly bit). The UI is explicitly minimal — resist scope creep (no JS framework, no live updates; polling = refresh the jobs page).
