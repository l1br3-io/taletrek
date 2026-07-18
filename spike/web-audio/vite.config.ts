import { defineConfig } from 'vite'

// No COI / no SharedArrayBuffer — mirrors the production app's hosting model
// (any static host, no COOP/COEP headers). Single-threaded only, which is fine
// for this spike: we're testing scheduling + lock behaviour, not threading.
export default defineConfig({
  server: { host: true },
})
