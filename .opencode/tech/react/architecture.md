# React Architecture

> Project-level structure and component tiering. Companion to react/patterns.md (./patterns.md) and react/coding-style.md (./coding-style.md).
>
> **Scope:** how to organize a whole app at the directory/file level — component categories, where new code goes, promotion between tiers, and the domain boundary. Single-component shape, naming, and JSX live in coding-style.md (./coding-style.md). Runtime idioms (state location, data fetching, Suspense/Error Boundaries, forms, composition) live in patterns.md (./patterns.md). This file does not re-teach either.

## Architecture Principles

1. **Domain-First** — UI depends on domain types and contracts (`src/types.ts`, `src/domain/`), never the reverse.
2. **Co-located Code** — every file lives next to its sole consumer, regardless of type (component, hook, utility, helper, store, type, constant). Lift to a shared location only when a second consumer appears — never speculatively.
3. **Tiered Files** — three tiers with explicit promotion rules. Applies to all file types, not just `.tsx` components.
4. **Async-First Integration** — every domain operation crosses the boundary as an async call; UI never reaches into transport details.
5. **Type Safety End-to-End** — types flow from domain contracts to UI without weakening or `any` escape hatches.

## Directory Structure

```
src/
├── App.tsx                       # Root component
├── main.tsx                      # Entry point and setup
├── types.ts                      # Domain types and contracts
├── routes/                       # Route-level pages — flat by default
│   ├── landing.tsx               #   flat: route stays a single file
│   └── [route]/                  #   graduated: route grew co-located files
│       ├── [Route]Page.tsx           #   entry container
│       ├── use[Route]State.ts        #   route-scoped state
│       ├── [Component].tsx           #   route-specific, non-shared
│       └── [helper].ts               #   route-scoped utility
├── components/                   # Tier 1: domain-agnostic, presentational
│   ├── Button.tsx
│   ├── Modal.tsx
│   └── ScreenBlocker.tsx
├── hooks/                        # ONLY hooks consumed by ≥2 routes
├── lib/                          # Shared utilities, bucketed by feature when crowded
├── context/                      # App-wide state (theme, settings, auth)
├── workers/                      # Web Workers
└── styles/                       # Global styles
```

**Conditional directories** — create only when needed:

- `domain-components/[domain]/` — when a domain-aware file is shared by ≥2 routes.
- `store/` — when the app has a backend or native bridge. Not needed for SPAs/PWAs.

`routes/` is the modern React Router convention; `pages/` is interchangeable — pick one per project.

Directory names are conventions, not mandates. Projects using `features/` instead of `domain-components/`, or `services/` instead of `store/`, follow the same architecture rules — co-location, promotion on demand, single-consumer before shared. The rules are what matter, not the directory names.

### Flat routes vs. route folders

A route starts as a **single flat file** (`routes/library.tsx`).

**Graduate to a folder** when the single file exceeds **~200 lines** OR the route needs **≥2 co-located files** (components, hooks, utilities, helpers). Create an entry container (`[Route]Page.tsx`) and move the route-specific files inside.

Files consumed by ≥2 routes stay in `components/` / `hooks/` / `lib/` — never in a route folder.

## Component Tiers

### Tier 1 — `components/` (presentational, domain-agnostic)

Presentational UI only. No domain types, no integration calls, no business rules.

- Accept data via props, emit events via callbacks.
- Reusable across routes without importing domain types.

Component shape, naming, and JSX rules live in coding-style.md (./coding-style.md).

### Tier 2 — `routes/` (route-specific)

Files scoped to one route. A route starts flat and graduates to a folder only when it meets the threshold above. State primitives and the container/presentational split are covered in patterns.md (./patterns.md) — the architectural rule here is **co-location**: a file lives next to its sole consumer.

### Tier 3 — `domain-components/` (shared, domain-aware) — conditional

Create this directory **only** when a domain-aware file is consumed by ≥2 routes.

Domain-aware means the file imports domain types or calls domain operations directly. When this tier is needed:

- Encapsulates domain-specific UI logic and validation.
- May call integration adapters (`store/`) and handle domain operations.
- The promotion target when a Tier 2 file gets a second consumer and retains domain coupling.

### Where does a new file go?

Applies to **every file type** — `.tsx` components, `.ts` hooks, utilities, helpers, stores, types, constants. No exempt category.

| If it…                                                       | Tier | Location                                                   |
| ------------------------------------------------------------ | ---- | ---------------------------------------------------------- |
| Has no domain knowledge and is generic UI                    | 1    | `components/`                                              |
| Used by one route only — **any file type**                   | 2    | `routes/[name]/` — co-located with its consumer            |
| Used by ≥2 routes **and** imports domain types               | 3    | `domain-components/[domain]/` — create dir on demand       |
| Used by ≥2 routes **but** has no domain knowledge            | 1    | `components/` / `hooks/` / `lib/` (promote, generalize)    |

**Default to Tier 2.** Promote only when a second consumer appears — never speculatively.

### Litmus test

Count consumers before deciding:

```bash
rg 'import.*from.*/useFoo' src/ | wc -l        # hooks (or grep -r)
rg 'import.*from.*/[Component]' src/ | wc -l    # components (or grep -r)
```

| Count             | Action                                             |
| ----------------- | -------------------------------------------------- |
| 1                 | Co-locate with that consumer in its route folder.  |
| ≥2                | Promote to `components/`, `hooks/`, `lib/`, or `domain-components/`. |

### Anti-pattern: global buckets for single-consumer files

Do not create catch-all directories (`hooks/`, `utils/`, `helpers/`) that collect files used by only one route. These directories:

- **Hide coupling** — a file in `hooks/` *looks* shared, but has one consumer. The directory name lies.
- **Make deletion scary** — you don't know who depends on it without a global search.
- **Grow forever** — no pressure to delete or co-locate, so dead code accumulates.
- **Resist refactoring** — moving a route-specific hook out of `hooks/` feels like a big change, when it should be a `git mv`.

A global `hooks/` (or `utils/`, `helpers/`) is acceptable **only** for files consumed by ≥2 routes. When in doubt, co-locate; promote later when a second consumer appears.

The same rule applies **inside a route folder**: do not create `helpers.ts`, `utils.ts`, or `common.ts` files that collect single-consumer functions. Each function belongs next to its sole consumer. If two functions in `helpers.ts` are used by different files, they're better off in their respective consumer files than in a shared bucket. Only extract a shared utility *file* when at least two files within the route import the same function.

## Route-Scoped State

Each route owns its state in a co-located hook, keeping the container lean and the state testable in isolation. State primitive choice (`useState` vs `useReducer` vs Context vs external store) follows the decision tree in patterns.md (./patterns.md). The architectural rule is **location**, not primitive selection.

## Integration Boundary (conditional)

**If your app has a backend or native bridge**, route all domain operations through a single `store/` adapter. The transport may be `fetch`, an IPC bridge, or a native shell; UI never knows which.

- Routes and domain-components call `store/` functions, never the transport directly.
- Async data caching/retry is handled by the server-state library (patterns.md).

**For SPAs/PWAs** with no backend, skip `store/`. Use `context/` for app-wide state (theme, settings, auth) and call `lib/` utilities directly from routes.

## Common Violations

| Violation                                                    | Why wrong                                            | Fix                                                           |
| ------------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------- |
| `hooks/useProfile.ts` used only by `routes/settings/`        | Looks shared — isn't. Hides coupling.                | `git mv hooks/useProfile.ts routes/settings/useProfile.ts`    |
| `components/BookCard.tsx` used only by `routes/library/`     | Tier 1 directory, but file is domain-specific.       | `git mv components/BookCard.tsx routes/library/BookCard.tsx`  |
| `utils/formatTitle.ts` used only by one route                | Global bucket for a single consumer.                 | Co-locate in that route's folder.                             |
| `routes/reader/helpers.ts` collecting functions each with one consumer | Route-internal catch-all — same anti-pattern. | Move each function into its sole consumer's file; delete the bucket. |
| `lib/` file imported only by one route                       | Looks shared — isn't.                                | Move into the route folder.                                   |

## Development Workflow

### Adding a route

1. Start flat: `routes/[name].tsx`.
2. Graduate to `routes/[name]/` when ≥2 co-located files accumulate OR the file exceeds ~200 lines.
3. Register the route in the router configuration.
4. Promote shared pieces out only when a second consumer appears.

### Promoting a file

When a second consumer appears:

1. **Tier 2 → Tier 3**: move to `domain-components/[domain]/` (domain-aware, now shared).
2. **Tier 2 → Tier 1**: move to `components/` (UI) or `hooks/` / `lib/` (non-UI) — generalize so no domain type leaks in.
3. Update imports at every call site in the same change.

Generalize props as part of the move — the file should accept only the values it needs, not the full state shape of its previous consumer.

## Migrating a Flat Structure

When a codebase has most files dumped into global buckets (`src/components/`, `src/hooks/`, `src/utils/`):

1. **Phase 1** — move route-specific files of **all types** (components, hooks, utilities, helpers) into their route directories.
2. **Phase 2** — keep only truly reusable, shared files in `components/` / `hooks/` / `lib/` — verify each has ≥2 consumers.
3. **Phase 3** — collect shared domain-aware components into `domain-components/[domain]/`.
4. **Phase 4** — as new routes land, co-locate by default; promote on demand rather than up front.
