# Runbook — Server-hosted SPA end-to-end smoke test

> Effort 5 (`server-hosted-spa`), task T19. The unit + integration suites prove
> the wiring; this runbook proves the **hosted shape works as a product** —
> login, upload, close-the-tab synth, reopen, play from where you left off.
> **Tier 3 is complete** (the SPA is a live client of the personal server) when
> this run succeeds. Mirrors [effort 4's runbook](../personal-server/runbook.md).

Manual, human-runnable (every step below was executed and recorded 2026-08-29 —
see [Passing criteria](#passing-criteria)). Not CI. Re-run it before declaring
any future effort that touches `web/src/lib/datasource/`, `server/src/http/`,
or the Docker image shipped.

---

## Prerequisites

1. **Docker** (any recent engine; verified on Docker 29.7.2 / buildx 0.36.1),
   ~2 GB free disk for the image. — or a Rust + pnpm toolchain for the local
   variant (§5): Rust 1.97.0, Node 24, pnpm 10.31.0.
2. **`curl`** + a **browser** (Chromium-family verified; Safari see §6).
3. A **token**: `openssl rand -hex 32`. The token is the entire auth surface
   (single-user, ADR-0013) — loopback-only for testing, TLS + a real secret
   for anything reachable beyond localhost.

---

## 1. Machine gates first

Cheap, hermetic, catch regressions before you spend walkthrough time:

```
cargo build --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace                       # → all suites "ok", 0 failed
pnpm verify                                  # → biome + tsc + vitest + vite build
```

The real-piper integration loops (`--ignored`, see
[`docs/testing.md`](../../testing.md)) cover the server synth path separately;
this runbook covers the hosted product loop.

## 2. Docker: build + run the full-stack image

One image is the whole stack — server binary + hosted SPA (built in-image by
the `spa` stage since T18; no separate `pnpm build` step):

```
docker build -f server/Dockerfile -t taletrek-server .
export TALETREK_TOKEN="$(openssl rand -hex 32)"
docker run -d --name tt -p 127.0.0.1:7878:7878 -e TALETREK_TOKEN=$TALETREK_TOKEN -v tt-data-t19:/data taletrek-server
```

> `-p 127.0.0.1:7878:7878` pins the publish to loopback for the walkthrough.
> For LAN/internet operation see [`docs/deploy-digitalocean.md`](../../deploy-digitalocean.md)
> — plain HTTP + a guessable token on an open network is a read/write library
> for anyone nearby.

First synth downloads the default curated voice (~63 MB) from HuggingFace
into `/data/voices/` on the data volume — network needed once, then cached.

## 3. Curl smoke (expected outputs)

```
curl -fsS http://127.0.0.1:7878/api/health                     # → ok  (only unauthed route)
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' \
  http://127.0.0.1:7878/                                       # → 303 …/ui/login
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7878/ui/admin
                                                               # → 404  (panel gone — T16)
curl -s -c /tmp/tt.jar -X POST http://127.0.0.1:7878/ui/login \
  --data-urlencode "token=$TALETREK_TOKEN" -o /dev/null -w '%{http_code}\n'
                                                               # → 303 (HttpOnly cookie set)
curl -s -b /tmp/tt.jar -o /dev/null -w '%{http_code} %{content_type}\n' \
  http://127.0.0.1:7878/manifest.webmanifest                   # → 200 application/manifest+json
curl -s -b /tmp/tt.jar -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7878/sw.js
                                                               # → 200 (PWA assets behind auth)
```

## 4. The hosted walkthrough (the point)

In a browser against `http://127.0.0.1:7878` (any small DRM-free EPUB; or
generate one — the recorded run used a 2-chapter/9-paragraph generated EPUB):

1. **Login gate:** open `/` unauthenticated → the no-JS login page. Sign in
   with the token → lands on `/` with the SPA booted in **server mode**
   (devtools: `localStorage['taletrek:hosted-shape'] === '1'`; the library is
   the server's, not IDB).
2. **PWA from the server origin:** devtools → Application → Service Workers:
   `sw.js` active; install the PWA from the omnibox (works because manifest +
   SW + icons are served behind the cookie).
3. **Upload:** Library → *Upload a book* → pick the EPUB. The browser parses
   it, POSTs the text-only bundle, and (hosted default) **auto-synth starts**
   — a banner ticks paragraph progress.
4. **Close the tab.** This is the Tier-3 moment: synthesis keeps running
   server-side. (Optional curl watch: `curl -s -b /tmp/tt.jar
   http://127.0.0.1:7878/api/jobs | python3 -m json.tool` → the job's `done`
   climbs to `total` with no client attached.)
5. **Reopen:** back on `/library` → the book shows an **Audio ready** chip.
6. **Play:** open the book → **Play** → real Opus streams segment-by-segment
   from `/api/books/:id/audio/:key` (Network tab), auto-advances paragraphs.
7. **Seek:** tap a later paragraph — playback re-anchors there (position
   PATCHes to the server, ~2 s debounced).
8. **Reload:** the reader resumes exactly where playback left off — position
   came from the server, not the device.

## 5. Local (non-Docker) variant

Same server binary from source, serving the locally built SPA:

```
pnpm build                     # → web/dist
just dev-server                # binds 127.0.0.1:7878, TALETREK_STATIC_DIR=web/dist, token dev-secret
```

For SPA-dev-with-server (Vite HMR + proxied `/api`): `just dev`. With no
server running, plain `pnpm dev` boots the standalone local-mode PWA — both
shapes from one codebase (ADR-0014).

## 6. Safari / Opus check (risk R2) — human gate

Ogg/Opus in `<audio>`/`decodeAudioData` is historically unsupported on Safari;
hosted playback there likely needs a wav/m4a codec bundle or server-side
transcode. **Verify on real Safari hardware before promising iOS-hosted
playback.** Carried evidence: both decode paths (desktop `<audio>`, Web Audio
`decodeAudioData`) proven on Chrome 151 (T15 + this run); the same Opus bytes
play in Safari via the effort-4 bundle-import path (2026-08-24 @ `22508db`) —
but the *hosted* playback engine has not run on Safari yet.

## Passing criteria

Effort 5 is smoke-clean when **all** of:

- [x] §1 machine gates green (`cargo build/clippy/test --workspace`,
      `pnpm verify`). *(2026-08-29 @ `d550eee`)*
- [x] §2 `docker build` + `docker run` → `/api/health` ok; full-stack image
      (SPA baked at `/web-dist`, no Node in the final stage). *(2026-08-29 @
      `d550eee`, image 926 MB, cold build 1 m 35 s)*
- [x] §3 curl smoke: gate/redirects/cookie/manifest/sw all as listed. *(2026-08-29 @ `d550eee`)*
- [x] §4 all 8 walkthrough steps, browser-driven (Chrome 151 headless,
      generated EPUB): login → server-mode boot (`hosted-shape=1`) → SW
      registered → upload → auto-synth → **tab closed, server finished the
      job alone** → reopen "Audio ready" → Play (11 Opus segment fetches,
      Play→Pause, paragraph auto-advance) → seek → reload → resumed on the
      tapped paragraph (`ch1 ¶5, fraction 1.00` from the server). *(2026-08-29
      @ `d550eee`)*
- [ ] §6 Safari/Opus on real hardware — **human-only, open**; carried evidence
      recorded above. Tracked as a follow-up gate, not an effort blocker (the
      hosted shape is secondary-platform until proven).

Record the run **date + commit** in `todo.md` (§Final gates) — that's the
Tier-3-completion sign-off.
