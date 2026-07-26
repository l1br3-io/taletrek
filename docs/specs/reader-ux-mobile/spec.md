---
status: shipped
started: 2026-07-23
shipped: 2026-07-23
---

# PRD: M7 — Reader UX & Mobile

> **Status:** Shipped.
> **Companions:** [`../../VISION.md`](../VISION.md), [`../../ROADMAP.md`](../ROADMAP.md).

## Objective

Make the reader comfortable on a phone. Ship a responsive, mobile-first reader layout with a chapter outline, minimized playback controls, a "go to current paragraph" affordance, and auto-scroll to the resumed position on first Play.

**User story:** *As a reader on my phone, I can follow along with the narration hands-free — the layout fits my screen, I can jump between chapters, and pressing play drops me exactly where I left off.*

## Shipped scope

- **Mobile-first responsive layout** — nav collapses into a drawer below `sm`; spacing and type scale adapt to the viewport.
- **Minimized playback bar** — collapses to primary controls (prev ¶, play/pause, next ¶) with an overflow menu (`⋯`) for chapter skip, stop, speed, outline, "go to current paragraph", and "transform paragraph".
- **Chapter outline drawer** — lists chapters, highlights the current one, and jumps on tap.
- **"Go to current paragraph"** — a button in the overflow menu plus a floating button that appears when the active paragraph is scrolled out of view; recenters the reader on what's playing.
- **Auto-scroll on first Play** — if the book has a saved position, the view scrolls to the resumed paragraph so pressing play drops the reader exactly where they left off.

## Notes

This milestone shipped without a separate ADR — it is a UX/ergonomics release, not an architecture decision. The reader layout and playback controls are documented in the codebase (`web/src/routes/reader`, `web/src/components`).
