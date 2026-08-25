import { localDatasource } from '../../lib/datasource'
import { ttsClient } from '../../lib/tts/client'

/**
 * Wipe everything TaleTrek stores on this device: IndexedDB (books, chapters,
 * uploaded files, settings, audio cache), OPFS voice models, Cache API (app
 * shell + Piper wasm), service worker registrations, and web storage. The
 * caller should reload the page afterwards so the app re-initializes clean.
 *
 * Best-effort — each step is independent and failures are swallowed so a
 * partial wipe (e.g. SW unregister fails) still clears the user data.
 */
export async function clearAllData(): Promise<void> {
  await Promise.allSettled([
    localDatasource.clearAllStores(),
    ttsClient.clearAllStored(),
    clearServiceWorkers(),
    clearCaches(),
    clearWebStorage(),
  ])
}

async function clearServiceWorkers(): Promise<void> {
  if (!('serviceWorker' in navigator)) return
  const registrations = await navigator.serviceWorker.getRegistrations()
  await Promise.allSettled(registrations.map((r) => r.unregister()))
}

async function clearCaches(): Promise<void> {
  if (typeof caches === 'undefined') return
  const keys = await caches.keys()
  await Promise.allSettled(keys.map((k) => caches.delete(k)))
}

function clearWebStorage(): void {
  try {
    localStorage.clear()
    sessionStorage.clear()
  } catch {
    // Best-effort — some browsers throw in private mode.
  }
}
