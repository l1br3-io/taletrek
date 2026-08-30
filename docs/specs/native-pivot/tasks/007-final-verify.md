# T7 — Final verify

**Description:** Close the effort: full gates + reference sweep against the allowlist.

- [x] `cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace`
- [x] `pnpm verify`
- [x] Sweep clean (allowlist: `CHANGELOG.md`, `docs/adrs/0015*`, `docs/specs/native-pivot/**`, ROADMAP history lines):

```
rg -n -i "personal-server|server-hosted|taletrek-server|deploy-digitalocean|0014-server" \
  --glob '!CHANGELOG.md' --glob '!docs/adrs/0015*' --glob '!docs/specs/native-pivot/**' \
  --glob '!docs/ROADMAP.md'
```

- [x] Manual smoke: `pnpm dev` → landing renders → open fixture bundle in reader → playback works
- [x] `todo.md` checkboxes complete; spec ready to flip `status: shipped` at merge
