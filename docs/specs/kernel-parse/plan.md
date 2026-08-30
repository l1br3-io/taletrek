# PLAN — kernel-parse

> Spec: [spec.md](./spec.md) · Track: [ADR-0015](../../adrs/0015-native-pivot-rust-kernel-and-native-apps.md)
> Shape: an **addition effort** — one new pure crate, six small parsers behind one API, thin CLI/web glue.

## Ordering & dependency graph

```
T1 skeleton+TXT ─► T3 clean+TXT chapters ─► T4 text-only bundle ─► T5 CLI parse ─► T11 chained synth ─► T13 docs+verify
      │                                                                            ▲
      └─► T2 PDF spike ─► T10 PDF parser ──────────────────────────────────────────┘ (formats feed the chain)
      └─► T6 MD ─► T7 HTML ─► T8 EPUB
      └─► T9 DOCX
T12 web sourceFormats (independent — parallel-safe anywhere after spec)
```

Vertical slice first: T1→T5 lands the complete TXT path (bytes → clean chapters → bundle → CLI) before any other format. The PDF spike runs early (highest-risk dep choice, fail fast) but its parser lands late (no dependents). Formats T6–T10 are independent slices sharing only the T1 API + T3 cleaning.

## Phases

| Phase | Tasks | Gate |
| --- | --- | --- |
| 0 — Spike | T1, T2 | TXT parses from fixture; PDF crate verdict recorded |
| 1 — First slice | T3, T4, T5 | **Checkpoint A:** `taletrek-desktop parse --input fixture.txt` → importable bundle |
| 2 — Formats | T6–T10 | **Checkpoint B:** all six formats golden-green |
| 3 — Close | T11, T12, T13 | **Checkpoint C:** chained e2e + web mapping + docs; full gates green |

## Risk plan

- **R1 PDF text quality** → T2 spikes `pdf-extract`+`lopdf` against committed fixtures before any parser code; swap decision (ask-first) happens there, not mid-T10.
- **R2 clean-port drift vs web `lib/clean`** → T3 idempotence test in Rust + T12 TS-side `cleanChapters`-unchanged test pin both ends.
- **R3 EPUB real-world variety** → hand-built thin reader on zip+quick-xml we control; lossy UTF-8 decode never fails a parse; fixtures grow as cases arrive.
- **R4 scope creep toward GUI/mobile** → the spec's non-goals list is the fence; UniFFI stays unwired.

## Verification commands (per gate)

```
cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --quiet
cargo test -p taletrek-parse --test golden --quiet
pnpm verify            # only T12+ touch web
just parse-fixture     # CLI smoke (Phase 1+)
```

## What this plan deliberately does NOT do

No MOBI, no AI/heuristic outline detection beyond the locked TXT line-split, no pronunciation at parse, no OCR, no UniFFI bindings, no GUI, no web upload — spec non-goals, efforts 3–5.
