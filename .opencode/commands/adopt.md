---
description: Adopt the harness into a project — detect tech, wire config, scaffold the agent map. Run once on setup, re-run as a health check
---

# /adopt

The front door. Bring the harness into a project (or reconcile an existing
setup), then hand off to `/spec`. Idempotent — safe to re-run; it fills gaps
and reports drift rather than overwriting.

## What it reconciles

Fill each, never silently overwrite (the `init-tech-declaration` rule: show a
diff first):

1. **Tech router** — via `init-tech-declaration` (detect →
   `.opencode/harness/rules/tech.md` router). Injected into every session.
2. **Config wiring** — `instructions` must include the tech router path.
   The skill owns the config filename variants and preserves other keys.
3. **Agent map** — scaffold `AGENTS.md` from
   `.opencode/skills/init-tech-declaration/AGENTS.template.md`
   ([agents.md](https://agents.md/) standard), kept as a lean index (see
   `context-engineering` § Rules File Lifecycle).

## AGENTS.md handling (non-destructive)

- **Absent** → scaffold a project map from the template; fill the
  `<PLACEHOLDER>`s by asking the user for the project name, build/test/lint
  commands, and boundaries.
- **Present + matches the stock-harness signature** (H1 `# OpenCode Agent
  Harness` together with the phrase `no multi-harness fragmentation`) → it's
  the harness's own map, not this project's. Offer to replace it with a
  project map; show the diff; write only on explicit confirmation.
- **Present + already customized** → preserve it. Note any missing
  agents.md-standard sections; do not rewrite.

## Steps

1. **Legacy layout check.** If harness folders are found at the project root
   (`agents/`, `commands/`, `skills/` at root instead of under `.opencode/`),
   this is a pre-0.1 adoption. Offer to migrate them under `.opencode/` (the
   modern layout) and update any root-relative path references. Show what
   will move; write only on confirmation. If `.opencode/` already has the
   harness, skip.
2. **Guard.** Confirm `.opencode/` has the harness folders (`agents/`,
   `commands/`, `skills/`, `harness/rules/`). If not, stop — `/adopt`
   configures an *existing* harness, it doesn't fetch one. Point the user to
   the installer: `python3 install.py install` (or see README § Quick start).
3. **Tech + config.** Run `init-tech-declaration` (detect-tech →
   `.opencode/harness/rules/tech.md` router → config `instructions` wiring),
   following its diff-first rule.
4. **Agent map.** Reconcile `AGENTS.md` per the handling above.
5. **Health summary.** Collect the `init-tech-declaration` report, then add:
   - `AGENTS.md` status (absent / stock-harness / customized).
   - Manifest: if `.opencode/harness/harness.json` exists, show installed
     version and whether an update is available. If absent, note the installer
     wasn't used (manual install) — the manifest enables `install.py update`.
6. **Post-adopt verification.** Remind the user to restart opencode (config
   loads once at startup), then in a new session verify the router is active:
   ask "what tech conventions should I load?" — the agent should cite the
   stacks from `.opencode/harness/rules/tech.md`.
7. **Hand off.** Suggest `/spec` to define what to build, or `/planning` if a
   spec already exists. Run `python3 .opencode/harness/scripts/check-refs.py`
   if any `.md` was added or moved.
