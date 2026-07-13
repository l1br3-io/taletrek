/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// Content-Security-Policy for the production build. Hardened across all
// directives per ADR-0004 (the CSP is the primary exfiltration defence for the
// M6 cloud API key). `default-src 'self'` locks every unlisted directive to
// same-origin; `connect-src` allows any HTTPS endpoint (the user's explicit
// cloud-provider choice) + localhost for self-hosted Ollama/LM Studio + the
// model CDNs. Build-only — never injected in dev so Vite's HMR websocket + test
// runners aren't blocked. Verify via `pnpm preview` + hard reload (gotcha #3).
const CSP = [
  "default-src 'self'",
  "connect-src 'self' https: http://localhost:* http://127.0.0.1:*",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

function contentSecurityPolicy(): Plugin {
  return {
    name: 'taletrek-csp',
    apply: 'build',
    transformIndexHtml(html) {
      const tag = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`
      return html.replace('<head>', `<head>\n    ${tag}`)
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    contentSecurityPolicy(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/pwa-192.png', 'icons/pwa-512.png'],
      manifest: {
        id: '/',
        name: 'TaleTrek',
        short_name: 'TaleTrek',
        description:
          'Free, open-source reading companion — turn any ebook into an audiobook with on-device text-to-speech.',
        theme_color: '#0b1120',
        background_color: '#0b1120',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        lang: 'en',
        categories: ['books', 'education', 'productivity'],
        icons: [
          { src: '/icons/pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/pwa-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icons/pwa-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // The WebLLM runtime chunks (worker + main-thread factory, ~6 MB each)
        // are lazy — only fetched when a reader enables the in-browser backend.
        // Excluded from precache so the default SW stays small; runtime-cached
        // below so in-browser AI still works offline after first use.
        globIgnores: ['**/webllm*.js'],
        cleanupOutdatedCaches: true,
        // The Piper WASM runtime (~39 MB) is too large to precache. Cache it on
        // first fetch so it's available offline thereafter — the app shell +
        // these binaries + the OPFS voice model together enable true offline.
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/wasm/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'piper-wasm',
              expiration: { maxEntries: 32, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: ({ url }) => /\/webllm[-.]/.test(url.pathname),
            handler: 'CacheFirst',
            options: {
              cacheName: 'webllm-runtime',
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      // Enable the SW in dev so offline/PWA behavior is testable locally.
      devOptions: {
        enabled: true,
        type: 'module',
      },
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        // Route the main-thread `@mlc-ai/web-llm` (lazy-imported in
        // `engines/webllm.ts`) into a named chunk so the SW can target it
        // (`webllm-runtime-*.js`). The worker chunk is already named from its
        // `webllm.worker.ts` entry. Both are excluded from precache above.
        manualChunks(id) {
          if (id.includes('@mlc-ai/web-llm')) return 'webllm-runtime'
          return undefined
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test-setup.ts'],
    css: true,
  },
})
