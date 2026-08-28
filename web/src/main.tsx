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
import { resolveDatasourceMode } from './lib/datasource'
import { isMediaSessionSupported, supportedMediaSessionActions } from './lib/media-session'
import { requestPersistence } from './lib/storage'
import {
  reconcileInterruptedTransforms,
  reconcileInterruptedUploads,
} from './lib/upload/boot-sweep'
import './styles/index.css'

const router = createBrowserRouter(routes)

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

// Best-effort boot sequence — runs before React mounts so the DB is reconciled
// before any component reads from it (avoids a race where a user opens
// /reader/<id> for a book the sweep is about to delete).
//
//   0. Resolve the deployment shape (ADR-0014): probe same-origin
//      /api/session — authed 200 → server mode (ServerDatasource); 401 →
//      redirect to /ui/login; unreachable/anything else → local mode. This
//      is what keeps the standalone PWA unchanged: a static origin 404s and
//      the app boots exactly as before. Resolved once, before render.
//   1. Ask the browser to exempt our storage from eviction (granted/denied
//      silently based on engagement).
//   2. Reconcile interrupted uploads from a previous session (ADR-0009):
//      clear stranded `uploading` flags or convert interrupted initial-mode
//      jobs to paused. Silent — logs only. LOCAL MODE ONLY: hosted mode has
//      no IndexedDB jobs to sweep.
//   3. Reconcile interrupted whole-book AI transforms (M13 / ADR-0012):
//      clear stranded `transforming` flags; if `transformJob` is present the
//      book surfaces as Paused in the library. Silent — logs only. Local
//      only, same reasoning.
//
// All best-effort; failures degrade gracefully and never block render.
void (async () => {
  const boot = await resolveDatasourceMode()
  console.info('[taletrek] datasource mode:', boot.mode)
  const granted = await requestPersistence()
  if (!granted) console.info('[taletrek] storage persistence not granted; cache may be evicted')
  if (boot.mode === 'local') {
    await reconcileInterruptedUploads().catch((error) => {
      console.info('[taletrek] boot-sweep (uploads) failed:', error)
    })
    await reconcileInterruptedTransforms().catch((error) => {
      console.info('[taletrek] boot-sweep (transforms) failed:', error)
    })
  }

  // Feature-detect the Media Session API (no playback until M2/M3).
  console.info('[taletrek] media session:', {
    supported: isMediaSessionSupported(),
    actions: supportedMediaSessionActions(),
  })

  createRoot(root).render(
    <StrictMode>
      <DatasourceProvider mode={boot.mode}>
        <SettingsProvider>
          <ErrorBoundary>
            <RouterProvider router={router} />
          </ErrorBoundary>
        </SettingsProvider>
      </DatasourceProvider>
    </StrictMode>,
  )
})()
