import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { routes } from './App'
import { SettingsProvider } from './context/settings'
import { isMediaSessionSupported, supportedMediaSessionActions } from './lib/media-session'
import { requestPersistence } from './lib/storage'
import { reconcileInterruptedUploads } from './lib/upload/boot-sweep'
import './styles/index.css'

const router = createBrowserRouter(routes)

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

// Best-effort boot sequence — runs before React mounts so the DB is reconciled
// before any component reads from it (avoids a race where a user opens
// /reader/<id> for a book the sweep is about to delete).
//
//   1. Ask the browser to exempt our storage from eviction (granted/denied
//      silently based on engagement).
//   2. Reconcile interrupted uploads from a previous session (ADR-0009):
//      clear stranded `uploading` flags or cascade-delete books whose synth
//      was killed mid-flight. Silent — logs only.
//
// Both are best-effort; failures degrade gracefully and never block render.
void (async () => {
  const granted = await requestPersistence()
  if (!granted) console.info('[taletrek] storage persistence not granted; cache may be evicted')
  await reconcileInterruptedUploads().catch((error) => {
    console.info('[taletrek] boot-sweep failed:', error)
  })

  // Feature-detect the Media Session API (no playback until M2/M3).
  console.info('[taletrek] media session:', {
    supported: isMediaSessionSupported(),
    actions: supportedMediaSessionActions(),
  })

  createRoot(root).render(
    <StrictMode>
      <SettingsProvider>
        <RouterProvider router={router} />
      </SettingsProvider>
    </StrictMode>,
  )
})()
