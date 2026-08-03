---
description: Snapshot of project state — active effort, task progress, resume notes, working tree, with the next task front and center. Add "verify" to also run pnpm verify (typecheck + test + lint + build).
---

# /status

Produce a read-only snapshot of where the TaleTrek project is right now. The
**next task** is the hero of the output — everything else is context for it.

## Modes

- `/status` — parse docs + git only. Fast (~1s). Default.
- `/status verify` — additionally run `pnpm verify` (typecheck + test + lint +
  build). Slower, but exposes stale "done" checkboxes. Treat `verify`
  (canonical) as the verify mode; anything else (or empty) is the default.

## What to read, in order

1. **Active effort discovery.** Read the frontmatter of every
   `docs/specs/*/spec.md`. The **active effort** is the one whose frontmatter
   has `status: active` (there should be exactly one).
   - **0 active** → the project is between efforts. Print the between-efforts
     notice (template below) pointing at `/spec` and `docs/ROADMAP.md`, and stop
     — do not invent a next task.
   - **>1 active** → ambiguous. Say so and ask the user; never guess.
2. `docs/specs/<active-slug>/todo.md` — the live checklist and the single
   status source the project resumes from:
   - The first `[ ]` task is **the next task** — promote it to the top. **Skip
     any "Follow-on efforts" / "NOT this one" section** — those items belong to
     future efforts, not this one.
   - Count `[x]` vs total (`[x]` + `[ ]`) over this effort's own tasks for
     progress. The current phase = the `## Phase` header the first `[ ]` sits
     under.
   - If every own task is `[x]`, the effort is complete — say so and point at
     `/ship` (and `docs/ROADMAP.md`) instead of printing a next task.
3. `docs/specs/<active-slug>/plan.md` → two things:
   - The "Resuming" section, if present (as-of state, completed work,
     deviations) — summarized, not copy-pasted. Mention the deviation count
     explicitly so the reader knows to consult the file before continuing.
   - The current phase's entry (files, "done when", risk) for the detail line.
4. `docs/specs/<active-slug>/tasks/00N-<task-slug>.md` — the next task's full
   entry (acceptance criteria, files, verification step, dependencies). Prefer
   its detail line over plan.md when the two differ; the per-task file is
   authoritative. If no per-task file matches, fall back to plan.md silently.
5. `docs/specs/<active-slug>/spec.md` title + the "Active track" table in
   `docs/ROADMAP.md` → confirm the effort name only; do not regurgitate the
   spec.
6. `git status --porcelain` → working-tree cleanliness.
7. `git log --oneline -1` → the most recent commit only (last hash + subject).

## Output template — active effort

```markdown
## TaleTrek status — <effort slug> (active)

### ▶ Next task
**<T# / phase·task> — <title>**
<one-line detail from tasks/00N-*.md (or plan.md)>

**To proceed:** `/build`        **Re-plan:** `/planning`

---

### Progress
- Tasks: <done>/<total> done — <Phase #> (<phase name>)
- Effort: `docs/specs/<slug>/spec.md` (status: active)

### Resume notes (from plan.md)
- <as-of line>
- <N> deviations on record — read before continuing.

### Working tree
- <clean | N uncommitted files>
- last: <hash> <subject>
```

## Output template — between efforts (no `status: active` spec)

```markdown
## TaleTrek status — between efforts

No `docs/specs/*/spec.md` has `status: active`.

**To proceed:** `/spec` to define the next effort · `docs/ROADMAP.md` for direction.

---

### Working tree
- <clean | N uncommitted files>
- last: <hash> <subject>
```

When `/status verify` is invoked, append a `### Verification` block after the
active-effort template with a one-line pass/fail for each command:

```markdown
### Verification
- `pnpm lint`: ✅
- `pnpm typecheck`: ✅
- `pnpm test`: ✅ (N tests)
- `pnpm build`: ✅
```

## Rules

1. **Read-only.** Never edit files, never commit, never push. `/status`
   observes and reports.
2. **The next task leads.** If the output had to be one line, it would be the
   next task's title and the `/build` suggestion. Everything else is
   supporting context.
3. **Graceful degradation.** If `plan.md` has no "Resuming" section, skip that
   block. If `todo.md` has no pending own task, replace the Next-task block
   with an effort-complete notice pointing at `/ship` and `docs/ROADMAP.md`.
   If no spec is active, use the between-efforts template. Never error out on
   a missing file — note it and continue.
4. **Verify never blocks.** If a verify-mode command fails, report the
   failure inline; do not abort the snapshot. Failures are signal, not
   exceptions.
5. **No speculation.** If the active effort is ambiguous (zero or multiple
   `status: active` specs), say so and ask the user rather than guessing the
   next task.
6. **Suggested next action is always the footer of the Next-task block:**
   `/build` to implement, or `/planning` to re-plan. For a complete effort,
   point at `/ship`. For between-efforts, point at `/spec`. Nothing else.
