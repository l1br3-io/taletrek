import { defineConfig } from 'vite'

// Spike config: intentionally minimal. WebLLM's documented worker pattern
// uses `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`,
// which Vite resolves natively — no special plugins needed. Go/no-go #1 is
// precisely "does this bundle cleanly under Vite + a dedicated worker".
export default defineConfig({
  server: { host: true },
})
