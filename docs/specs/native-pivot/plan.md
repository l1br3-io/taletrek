# PLAN — native-pivot

> Spec: [spec.md](./spec.md) · Decision: [ADR-0015](../../adrs/0015-native-pivot-rust-kernel-and-native-apps.md)
> Shape: a **subtraction effort** — deletions + doc rewrites; the only new code is the landing page.

## Ordering & dependency graph

```
T1 ADR-0015 ─► T2 server purge ─► T3 SPA scope-down ─► T4 docs audit ─► T5 VISION/ROADMAP/AGENTS ─► T6 landing v1 ─► T7 final verify
                                     (T4 runs after T3: audit decisions follow what code survived)
```

T6 depends only on T3 (routes exist) and can move earlier if desired.

## Phases

| Phase | Tasks | Gate |
| --- | --- | --- |
| 0 — Decision | T1 | ADR-0015 written; ADR-0013 status amended |
| 1 — Server purge | T2 | `cargo check/clippy/test --workspace` green; code+config sweep clean |
| 2 — Web purge | T3 | `pnpm verify` green; reader opens a v1 bundle fixture |
| 3 — Docs | T4, T5 | docs tree tells the native story only; no dangling links |
| 4 — Surface | T6 | landing renders (apps + CLI + reader) |
| 5 — Close | T7 | full sweep + full gates; spec ready to flip shipped |

## Risk plan

- **R1 breadth** → delete in order: workers → upload lib → AI/crypto → datasource seam → UI surfaces; typecheck between steps.
- **R3 archaeology** → keep a running hit-list; final sweep (T7) with allowlist (`CHANGELOG.md`, ADR-0015, ROADMAP history lines).
- **R4 gotcha IDs** → retire-in-place, no renumbering; a header note explains the gaps.

## Verification commands (per gate)

```
cargo check --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
pnpm verify
rg -n -i "personal-server|server-hosted|taletrek-server|deploy-digitalocean|0014-server" \
  --glob '!CHANGELOG.md' --glob '!docs/adrs/0015*' --glob '!docs/specs/native-pivot/**'
```

## What this plan deliberately does NOT do

No `crates/parse`, no GUI, no mobile scaffolds, no store work — efforts 2–5. The branch stays reviewable: deletions, docs, one small page.
