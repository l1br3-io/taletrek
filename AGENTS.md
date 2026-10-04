# TaleTrek — Agent Skills

This project uses the [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) pack, installed under `.agents/` and `.opencode/`. Reusable workflows (skills), shared checklists (references), lifecycle slash commands, and specialist personas are all wired up and auto-discovered.

## Locations

| Asset | Path |
|-------|------|
| Skills | `.agents/skills/<name>/SKILL.md` |
| Shared checklists | `.agents/references/*.md` |
| Slash commands | `.opencode/commands/*.md` |
| Personas (subagents) | `.opencode/agents/*.md` |

## Core rules

- If a task matches a skill, load it with the `skill` tool before acting.
- Follow the skill workflow strictly — do not partially apply it.
- Never skip required steps (spec, plan, test) a skill demands.
- Every change clears the project-wide Definition of Done in `.agents/references/definition-of-done.md`.
- Commands are silent on success and announce on failure: justfile recipes echo nothing on success (see `set quiet` in the justfile) and fail loudly; slash commands give a concise result on success and surface failures prominently instead of burying them.

## Intent → skill mapping

- New feature / significant change → `spec-driven-development`, then `incremental-implementation` + `test-driven-development`
- Planning / breakdown → `planning-and-task-breakdown`
- Bug / failure / unexpected behavior → `debugging-and-error-recovery`
- Code review → `code-review-and-quality`
- Refactoring / simplification → `code-simplification`
- API or module boundary design → `api-and-interface-design`
- Rust code / review → `rust-best-practices`
- Security-sensitive input, auth, secrets, dependencies → `security-and-hardening`
- Performance requirements or suspected regressions → `performance-optimization`
- Making a change (always) → `git-workflow-and-versioning`

## Slash commands

`/spec`, `/plan`, `/build [auto]`, `/test`, `/review`, `/constraints`, `/code-simplify`, `/ship`, `/webperf`. Run `/ship` before merge for a parallel fan-out review.

## Personas

`code-reviewer`, `security-auditor`, `test-engineer`, `web-performance-auditor` — single-role subagents invoked by `/ship` / `/webperf` (or directly). **Personas do not invoke other personas**; orchestration belongs to slash commands and the main session (see `.agents/references/orchestration-patterns.md`).

## Project notes

- Rust (`crates/`, `desktop/`): run `cargo clippy` and `cargo fmt --check` before a change counts as done; `cargo test` is the verification gate.
- Web (`web/`, Vite + React + TypeScript): `pnpm verify` (biome check, typecheck, vitest, build) is the gate.
- Android (`android/`, Kotlin) and iOS (`ios/`, Swift) shells build with their native toolchains; on-device behavior is verified manually.
## Git is the spec trail

The spec directories and task ledgers are gone — folded into history on
2026-10-04. `git log` is the project's documentation: every effort's
context, decisions, deviations, and outcome live in its commits.

- The commit that completes an effort carries this appended block
  (natural prose, no trailers):

  ```
  ---
  Context: why this work existed (1-3 lines)
  Decisions:
  - key choices and their reasons
  Deviations:
  - where implementation diverged from plan (omit section if none)
  Outcome: what shipped and how it was verified
  ```

- Lookup idiom: `git log --grep='<effort-slug>'` (e.g.
  `git log --grep='progressive-synth'`) surfaces an effort's commits; the
  completion commit carries the distilled block.
- Architecture decision records stay in `docs/adrs/`; the why of the
  platform direction in `docs/ideas/`; product framing in
  `docs/ROADMAP.md` / `docs/VISION.md`.
- New work records its context/decisions/deviations in commit messages
  per the template — do not recreate spec or task directory trees.

### Local planning artifacts (transient)

- `/spec` and `/plan` still produce local working docs: `SPEC.md`
  (master index: capability map, dependency direction, build order,
  per-module status) + `SPEC-<module-id>.md` + `plans/<module-id>.md`
  chunks; aggregates at `plans/plan.md` and `plans/todo.md`.
- All are gitignored via `SPEC*.md` and `/plans`. Never commit them;
  their durable content is meant to land in commit messages.
- Module ids come from the capability map in `SPEC.md`, are chosen once,
  and are never renamed mid-initiative.
- `/build` consumes the chunk files; see `.opencode/commands/build.md`.
- PRs must copy the module's success criteria into the PR body, since
  reviewers cannot see the local planning files.
