# Task 019: Deploy guide + runbook + CHANGELOG + final gates

**Description:** Ship prep: the DigitalOcean one-command deploy guide, the effort runbook (machine-reproducible walkthrough mirroring effort 4's `runbook.md`), CHANGELOG entry, and the final gates. Also the docs index updates that ship with the effort: AGENTS.md current-effort pointer → this spec (until superseded), track doc status line, gotchas index lines for any new entries, `docs/developing.md` already covered by T12.

**Acceptance criteria:**
- [x] `docs/specs/server-hosted-spa/runbook.md`: step-by-step — build + run server with static dir, seed data, the hosted walkthrough (login → upload → synth-with-tab-closed → reopen → position + play), Safari/Opus check, docker variant. Machine gates listed with expected output.
- [x] Deploy guide (extend `docs/developing.md` or new `docs/deploy-digitalocean.md`): Droplet or App Platform one-liner (docker run with volume + token + reverse-proxy/TLS note), matching effort-4's self-hosted trust language.
- [x] `CHANGELOG.md` entry for the effort (user-facing: dual-shape SPA, server hosting, new endpoints, panel removal).
- [x] `docs/off-device-synth-track.md` + `AGENTS.md` status pointers updated (effort 5 shipped; follow-ons listed).
- [x] Runbook walkthrough executed and recorded in `todo.md` (dated commit hash, like effort 4). *(2026-08-29 @ `d550eee`)*
- [x] Final gates (todo.md §Final gates) all checked: workspace cargo build/clippy/test, `pnpm verify`, docker build+run walkthrough.

**Verification:**
- [ ] `python3 .opencode/harness/scripts/lint-plan.py` clean; `lint-frontmatter.py` clean.
- [ ] All links in new docs resolve (`check-refs.py` if applicable).
- [ ] todo.md fully flipped except human-only items explicitly annotated.

**Dependencies:** T18 (and everything)

**Files likely touched:**
- `docs/specs/server-hosted-spa/runbook.md` (new)
- `docs/deploy-digitalocean.md` (new) or `docs/developing.md`
- `CHANGELOG.md`, `docs/off-device-synth-track.md`, `AGENTS.md` (index lines only)

**Docs:** This task is docs.

**Estimated scope:** Medium (4-6 files, all docs)
