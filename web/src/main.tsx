import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { routes } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { DatasourceProvider } from './context/datasource'
import { SettingsProvider } from './context/settings'
// Side-effect import: attaches the `beforeinstallprompt` / `appinstalled`
// listeners at module load — before React mounts — so the event Chrome fires
// on first page load is captured even if the user hasn't opened Settings yet
// (where the install affordance lives). See `lib/install-prompt.ts`.
import './lib/install-prompt'
import { isMediaSessionSupported, supportedMediaSessionActions } from './lib/media-session'
import { requestPersistence } from './lib/storage'
import './styles/index.css'

const router = createBrowserRouter(routes)

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

// Best-effort boot sequence — runs before React mounts.
//
//   1. Ask the browser to exempt our storage from eviction (granted/denied
//      silently based on engagement).
//   2. Feature-detect the Media Session API.
//
// The native pivot (ADR-0015) removed the dual-shape probe and the boot
// sweeps — the reader is a local IndexedDB app, full stop. Failures degrade
// gracefully and never block render.
void (async () => {
  const granted = await requestPersistence()
  if (!granted) console.info('[taletrek] storage persistence not granted; cache may be evicted')

  console.info('[taletrek] media session:', {
    supported: isMediaSessionSupported(),
    actions: supportedMediaSessionActions(),
  })

  createRoot(root).render(
    <StrictMode>
      <DatasourceProvider>
        <SettingsProvider>
          <ErrorBoundary>
            <RouterProvider router={router} />
          </ErrorBoundary>
        </SettingsProvider>
      </DatasourceProvider>
    </StrictMode>,
  )
})()
