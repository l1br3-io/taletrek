import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { routes } from './App'
import { SettingsProvider } from './context/settings'
import { isMediaSessionSupported, supportedMediaSessionActions } from './lib/media-session'
import { requestPersistence } from './lib/storage'
import './styles/index.css'

// Debug: inject vConsole on touch devices (M9 iOS testing)
if (matchMedia('(pointer: coarse)').matches) {
  import('vconsole').then(({ default: VConsole }) => new VConsole())
}

const router = createBrowserRouter(routes)

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

// Best-effort: ask the browser to exempt our storage from eviction.
// Resolves silently (granted/denied by the browser based on engagement).
void (async () => {
  const granted = await requestPersistence()
  if (!granted) console.info('[taletrek] storage persistence not granted; cache may be evicted')
})()

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
