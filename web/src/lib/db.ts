import { type DBSchema, type IDBPDatabase, openDB } from 'idb'

/**
 * TaleTrek IndexedDB schema.
 *
 * M0 only activates the `settings` store. `books` and `chapters` are reserved
 * for M1+ and added via a future version bump — do not create them here.
 */
export interface TaleTrekDB extends DBSchema {
  settings: {
    key: string
    value: unknown
  }
}

const DB_NAME = 'taletrek'
const DB_VERSION = 1

let dbPromise: Promise<IDBPDatabase<TaleTrekDB>> | null = null

/** Open (and memoize) the TaleTrek database. Safe to call repeatedly. */
export function getDB(): Promise<IDBPDatabase<TaleTrekDB>> {
  if (!dbPromise) {
    dbPromise = openDB<TaleTrekDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings')
        }
      },
    })
  }
  return dbPromise
}

/** Reset the memoized connection — test-only escape hatch. */
export function _resetDBForTests(): void {
  dbPromise = null
}

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
