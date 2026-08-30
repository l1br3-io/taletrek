# T6 — Landing page v1

**Description:** The landing route becomes the storefront for the new shape: what TaleTrek is, the native apps (desktop first — "coming soon" placeholders for Android/iOS), the CLI path for today, and the door into the web reader (open a `.taletrek`). Keep the existing design language (Tailwind tokens, lucide icons, `❯~` brand mark).

- [ ] Hero: product pitch updated to the kernel/apps story (no "runs in your browser" claims)
- [ ] Apps section: Desktop (synth processor — the first ship), Android/iOS placeholders with store-badges-to-come
- [ ] "Today" path: install via CLI/bundle instructions (however users actually get books until apps ship) + open a `.taletrek` in the web reader
- [ ] Existing landing tests updated; smoke test for new sections

**Files:** `web/src/routes/landing/*`
**Verify:** `pnpm verify` green; visual check via `pnpm dev`
