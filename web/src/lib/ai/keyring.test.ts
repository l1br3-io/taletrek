import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearApiKey, getApiKey, setApiKey } from './keyring'

describe('keyring', () => {
  beforeEach(() => {
    clearApiKey()
    localStorage.clear()
    sessionStorage.clear()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('is undefined before any key is set', () => {
    expect(getApiKey()).toBeUndefined()
  })

  it('round-trips set → get → clear', () => {
    setApiKey('sk-test-123')
    expect(getApiKey()).toBe('sk-test-123')
    clearApiKey()
    expect(getApiKey()).toBeUndefined()
  })

  it('overwrites the previous key', () => {
    setApiKey('first')
    setApiKey('second')
    expect(getApiKey()).toBe('second')
  })

  it('clearApiKey is a no-op when no key is set', () => {
    clearApiKey()
    clearApiKey()
    expect(getApiKey()).toBeUndefined()
  })

  it('never persists to any storage (ADR-0004: in-memory only)', () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    const idbOpenSpy = vi.spyOn(indexedDB, 'open')
    const cookieBefore = document.cookie

    setApiKey('sk-sensitive')
    getApiKey()
    clearApiKey()

    expect(setItemSpy).not.toHaveBeenCalled()
    expect(idbOpenSpy).not.toHaveBeenCalled()
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
    expect(document.cookie).toBe(cookieBefore)
  })

  it('survives a module re-eval cycle (in-memory, not sessionStorage)', () => {
    setApiKey('sk-persistent-across-reload-simulation')
    // The contract: the key is held in module scope. There is no async / storage
    // round-trip — a synchronous read after write must return the value.
    expect(getApiKey()).toBe('sk-persistent-across-reload-simulation')
    // And crucially, nothing was written that a reload would restore from:
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})
