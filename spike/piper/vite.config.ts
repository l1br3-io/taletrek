import { defineConfig } from 'vite'
import crossOriginIsolation from 'vite-plugin-cross-origin-isolation'

// Spike config: COI=1 enables cross-origin isolation (COOP+COEP) so
// onnxruntime-web uses its multi-threaded (SharedArrayBuffer) backend.
// Without it, ORT falls back to single-threaded. Used to compare the two.
const enableCOI = process.env.COI === '1'

export default defineConfig({
  plugins: enableCOI ? [crossOriginIsolation()] : [],
  server: { host: true },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
})
