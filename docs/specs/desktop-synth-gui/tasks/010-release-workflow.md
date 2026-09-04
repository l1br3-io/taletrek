# T10 — Release workflow (GH Actions matrix → artifacts)

**Description:** Free-download distribution per the spec: a tag push builds release artifacts in CI. Linux x86_64 is first-class; aarch64-linux, Windows, macOS are best-effort (`continue-on-error`), informed by the T1/T2 static-linking outcomes. Hand-rolled workflow — no cargo-dist scaffolding (repo taste: conservative, explicit).

**Work:**
- [x] `.github/workflows/release.yml`: on tag `v*` — matrix {`x86_64-unknown-linux-gnu` first-class; `aarch64-unknown-linux-gnu`, `x86_64-pc-windows-msvc`, `aarch64-apple-darwin` best-effort}; build `--release` with default features (native engines); native build deps installed per T1/T2 verdicts (cmake/libclang/etc.); artifact upload per-target (`taletrek-<version>-<target>[.tar.gz|.zip]`)
- [x] glibc vs musl decided from spike outcomes (static-preferred); record the call in this file
- [x] Smoke step in the Linux job: the built binary runs `taletrek-desktop --version` and `parse` on a fixture (headless — no GUI launch in CI), proving the artifact isn't broken before upload
- [x] `workflow_dispatch` trigger for dry runs; artifact names documented in `docs/developing.md` (or a short `docs/releasing.md` if it needs more than 5 lines)
- [x] Workflow passes lint (yamllint-equivalent — at minimum valid YAML + actioncheck via a dry dispatch)

**Acceptance:**
- [x] `workflow_dispatch` dry run on this branch: Linux job green, artifact attached, smoke step passes
- [x] Best-effort targets either green or visibly non-blocking
- [x] Tag → release flow documented in one place

**Verify:** the dispatch run URL + artifact list pasted in this file.

**Dependencies:** T9 (packaging the finished app), informed by T1/T2
**Files:** `.github/workflows/release.yml`, `docs/developing.md`
**Docs:** releasing rows in developing.md
**Estimated scope:** M

---

## Close-out (2026-09-04)

### glibc vs musl — **glibc (`x86_64-unknown-linux-gnu`)**

T1/T2 proved every heavy native dep statically links under the `gnu` target:
onnxruntime + espeak-ng + piper_phonemize come from k2-fsa's prebuilt static
archive (no cmake, no libclang), libopus from the `opus` crate's `bundled`
feature (cmake + C compiler only). What stays dynamic is baseline system libs
(libc/libstdc++/libm/libgcc_s) — so musl would buy zero portability while
risking the k2-fsa archive link (their static prebuilts target gnu). Recorded
in the workflow comment and `docs/releasing.md`.

### Dry-run verification

- Run: <https://github.com/l1br3-io/taletrek/actions/runs/33836581714>
  (`workflow_dispatch` on `desktop-synth-gui`) — **conclusion: success, 4/4
  jobs green** (best-effort targets passed outright; `continue-on-error` +
  `fail-fast: false` stay as the safety margin).
- Smoke (Linux job log): `taletrek-desktop 0.1.0` + `parse` of
  `crates/parse/testdata/plain.txt` → `smoke OK: 1003 bytes` — headless, no
  GUI/display.
- Artifacts (run artifacts page): `taletrek-0.1.0-x86_64-unknown-linux-gnu`
  (25.6 MB) · `taletrek-0.1.0-aarch64-unknown-linux-gnu` (24.9 MB) ·
  `taletrek-0.1.0-x86_64-pc-windows-msvc` (16.1 MB) ·
  `taletrek-0.1.0-aarch64-apple-darwin` (17.2 MB).
- Tag path (release attachment via `softprops/action-gh-release@v2`,
  `contents: write`) is exercised only on real tags — same build/package/upload
  steps as the dry run.

### Gotcha: dispatching a branch-only workflow

GitHub registers `workflow_dispatch` workflows **from the default branch
only** — a workflow file living just on a feature branch 404s on dispatch.
Resolution (human-approved): registration commit `e74e50e` pushed the identical
`release.yml` to `main` (built on `origin/main`, one file, no effort history);
dispatching `--ref desktop-synth-gui` then runs the branch's copy. The effort
merge lands the same file, so `main`'s copy is a pure dispatch key.

