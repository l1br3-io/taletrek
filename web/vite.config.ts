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
  server: {
    // 8253 spells "TALE" on a phone keypad — unique to this project so it never
    // collides with other dev servers (Vite default 5173, spikes on 5174/5175).
    // strictPort: fail loudly on conflict instead of silently hopping ports.
    port: 8253,
    strictPort: true,
    allowedHosts: ['lodge-loop-massive-greatest.trycloudflare.com'],
    // Server-hosted shape in dev (`just dev`): same-origin `/api` + the login
    // form proxy to the personal server, so the boot probe and the 401 →
    // /ui/login redirect behave exactly like the hosted build. Only /ui/login
    // of the panel is proxied — post-login lands on `/`, which Vite serves.
    // With no server running the proxy errors, which the probe treats as
    // unreachable → local mode (standalone PWA unchanged).
    proxy: {
      '/api': 'http://127.0.0.1:7878',
      '/ui/login': 'http://127.0.0.1:7878',
    },
  },
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
        cleanupOutdatedCaches: true,
        // Server-owned paths must never resolve to the offline SPA shell:
        // `/ui/login` is the no-JS cookie gate (a SW-served index.html there
        // makes the unauthed probe redirect back into itself — an endless
        // navigation loop after logout), and `/api/*` answers as JSON or
        // nothing. T16; the audit in T17 keeps watch on this list.
        navigateFallbackDenylist: [/^\/api\//, /^\/ui\//],
        // The Piper WASM runtime (~39 MB) is too large to precache. Cache it on
        // first fetch so it's available offline thereafter — the app shell +
        // these binaries + the OPFS voice model together enable true offline.
        runtimeCaching: [
          /**
           * GOTCHA (T17 / R3 / G3): server-owned paths are network-only. In the
           * hosted shape every `/api/*` fetch and the `/ui/login` cookie gate
           * must hit the network or fail — a cached API response (or a
           * SW-served shell for /ui/*) would show stale library data as
           * current, or re-create the T16 post-logout redirect loop. Listed
           * FIRST so it wins over any future, broader runtimeCaching pattern.
           * `NetworkOnly` never calls cache.put on any status; a failed
           * network request rejects (hosted mode is online-only by decision).
           */
          {
            urlPattern: ({ url }) =>
              url.pathname.startsWith('/api/') || url.pathname.startsWith('/ui/'),
            handler: 'NetworkOnly',
          },
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/wasm/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'piper-wasm',
              expiration: { maxEntries: 32, maxAgeSeconds: 60 * 60 * 24 * 365 },
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
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test-setup.ts'],
    css: true,
  },
})
