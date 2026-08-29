# Task 018: Dockerfile builds the SPA + docker e2e

**Description:** The deployable artifact becomes the full stack: extend the multi-stage Dockerfile with a Node/pnpm stage that builds `web/dist`, copy it into the final image at the path `TALETREK_STATIC_DIR` expects, and verify the whole effort end-to-end in the container (login → SPA → upload → synth → play). Keep the image lean (dist is static bytes; no Node in the final stage).

**Acceptance criteria:**
- [x] `server/Dockerfile`: new stage `pnpm build` (corepack/pnpm 10, workspace-aware — only `web/` needs building; reuse layer caches sanely), final stage copies `dist/` to the static dir default (align with T8's default or set the env in the image).
- [x] `.dockerignore` covers `node_modules`, `target`, dev artifacts so context stays small.
- [x] Build args/env unchanged for operators besides the existing ones; README/runbook updated with the new build step (or note that it's automatic).
- [ ] `docker build -f server/Dockerfile -t taletrek-server .` succeeds; `docker run -p 127.0.0.1:7878:7878 -e TALETREK_TOKEN=... -v tt-data:/data` → browser walkthrough: login → SPA loads → upload small EPUB → synth (seeded voice or curated download) → play. PWA installability spot-check from the server origin.

**Verification:**
- [ ] Docker build + run walkthrough above (record versions/timings in task completion). *(Partial: build 1m35s cold-ish; run walkthrough done at curl level — full detail in `todo.md` T18 notes; browser visual pass folds into T19's manual runbook gate.)*
- [x] `cargo test --workspace` + `pnpm verify` still green (no source change expected beyond Dockerfile/ignore).

**Dependencies:** T8 (static serving), T16 (panel gone, SPA is the UI), T17 (SW scoping) — effectively "all of Phase 3"

**Files likely touched:**
- `server/Dockerfile`
- `.dockerignore` (new or extended)
- `server/README.md` or `docs/deploying.md` pointer

**Docs:** Build-stage notes inline in Dockerfile comments (ops-facing, allowed).

**Estimated scope:** Medium (2-3 files)
