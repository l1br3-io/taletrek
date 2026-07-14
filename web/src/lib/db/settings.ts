import { AUDIO_CACHE_BUDGET_BYTES, getDB } from './connection'

/** Private settings key for the current audio cache budget in bytes. Written
 * by `SettingsProvider`, read by `getEffectiveAudioCacheBudget` (which runs
 * inside the TTS worker — can't share module state with the main thread). */
const AUDIO_CACHE_BUDGET_KEY = '__audioCacheBudgetBytes'

/** Read a setting value by key, or `undefined` if absent. */
export async function getSetting<T>(key: string): Promise<T | undefined> {
  const db = await getDB()
  return (await db.get('settings', key)) as T | undefined
}

/** Write a setting value, overwriting any existing value for that key. */
export async function setSetting<T>(key: string, value: T): Promise<void> {
  const db = await getDB()
  await db.put('settings', value, key)
}

/** Remove a setting value. No-op if the key does not exist. */
export async function deleteSetting(key: string): Promise<void> {
  const db = await getDB()
  await db.delete('settings', key)
}

/** Write the effective audio cache budget (bytes) to IDB so the TTS worker
 * can read it. Called by `SettingsProvider` on hydration + budget changes. */
export async function syncAudioCacheBudget(bytes: number): Promise<void> {
  await setSetting(AUDIO_CACHE_BUDGET_KEY, bytes)
}

/** Read the effective audio cache budget from IDB, falling back to the
 * 500 MB default. Safe to call from the TTS worker (shared IDB). */
export async function getEffectiveAudioCacheBudget(): Promise<number> {
  const stored = await getSetting<number>(AUDIO_CACHE_BUDGET_KEY)
  return stored ?? AUDIO_CACHE_BUDGET_BYTES
}
