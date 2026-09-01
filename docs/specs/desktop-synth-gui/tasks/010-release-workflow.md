# T10 — Release workflow (GH Actions matrix → artifacts)

**Description:** Free-download distribution per the spec: a tag push builds release artifacts in CI. Linux x86_64 is first-class; aarch64-linux, Windows, macOS are best-effort (`continue-on-error`), informed by the T1/T2 static-linking outcomes. Hand-rolled workflow — no cargo-dist scaffolding (repo taste: conservative, explicit).

**Work:**
- [ ] `.github/workflows/release.yml`: on tag `v*` — matrix {`x86_64-unknown-linux-gnu` first-class; `aarch64-unknown-linux-gnu`, `x86_64-pc-windows-msvc`, `aarch64-apple-darwin` best-effort}; build `--release` with default features (native engines); native build deps installed per T1/T2 verdicts (cmake/libclang/etc.); artifact upload per-target (`taletrek-<version>-<target>[.tar.gz|.zip]`)
- [ ] glibc vs musl decided from spike outcomes (static-preferred); record the call in this file
- [ ] Smoke step in the Linux job: the built binary runs `taletrek-desktop --version` and `parse` on a fixture (headless — no GUI launch in CI), proving the artifact isn't broken before upload
- [ ] `workflow_dispatch` trigger for dry runs; artifact names documented in `docs/developing.md` (or a short `docs/releasing.md` if it needs more than 5 lines)
- [ ] Workflow passes lint (yamllint-equivalent — at minimum valid YAML + actioncheck via a dry dispatch)

**Acceptance:**
- [ ] `workflow_dispatch` dry run on this branch: Linux job green, artifact attached, smoke step passes
- [ ] Best-effort targets either green or visibly non-blocking
- [ ] Tag → release flow documented in one place

**Verify:** the dispatch run URL + artifact list pasted in this file.

**Dependencies:** T9 (packaging the finished app), informed by T1/T2
**Files:** `.github/workflows/release.yml`, `docs/developing.md`
**Docs:** releasing rows in developing.md
**Estimated scope:** M
