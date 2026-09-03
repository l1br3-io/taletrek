# T6 — Pure queue state machine (`gui/queue.rs`)

**Description:** The UI-free heart of the GUI: a job queue where every state transition is a pure function of an event. egui will only render this and forward user actions as events. Written and unit-tested before any egui code exists, so the GUI tasks never invent state logic on the fly.

**Work:**
- [x] `desktop/src/gui/queue.rs`: `JobKind` (`Convert { input, voice }` | `ReVoice { input, voice }`), `JobState` (`Queued | Running { done, total } | Done(out) | Failed(msg) | Cancelled`), `Queue` with `push`, `tick(QueueEvent)`, `next_job()`, `cancel(id)`
- [x] `QueueEvent` covering: job started, paragraph progress (done/total), job finished (out path), job failed (typed-ish message), user cancel
- [x] Transitions are total + defensive: events for unknown jobs are no-ops, cancel of a `Done` job is a no-op, one job `Running` at a time (sequential jobs, parallel paragraphs — per spec)
- [x] Unit tests beside the module: happy path, mid-progress failure, cancel during run, multi-job ordering (FIFO), event-for-unknown-job no-op
- [x] Module compiles with zero egui imports (test enforces: `cargo build -p taletrek-desktop --no-default-features` or a compile-assert as the wiring allows)

**Acceptance:**
- [x] All queue unit tests green; no egui/UI types in `queue.rs`
- [x] clippy `-D warnings` clean
- [x] The egui tasks (T7+) consume this API unchanged

**Verify:** `cargo test -p taletrek-desktop queue` + clippy.

**Dependencies:** None (parallelizable with Phase 1)
**Files:** `desktop/src/gui/queue.rs` (+ `desktop/src/gui/mod.rs` stub declaring the module)
**Docs:** module doc — none needed beyond rustdoc
**Estimated scope:** M
