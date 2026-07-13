import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearAllKeys, clearApiKey, getApiKey, hasAnyKey, setApiKey } from './keyring'

describe('keyring', () => {
  beforeEach(() => {
    clearAllKeys()
    localStorage.clear()
    sessionStorage.clear()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('is undefined before any key is set', () => {
    expect(getApiKey('p1')).toBeUndefined()
  })

  it('round-trips set → get → clear for one provider', () => {
    setApiKey('p1', 'sk-test-123')
    expect(getApiKey('p1')).toBe('sk-test-123')
    clearApiKey('p1')
    expect(getApiKey('p1')).toBeUndefined()
  })

  it('stores keys for multiple providers independently', () => {
    setApiKey('p1', 'sk-openrouter')
    setApiKey('p2', 'sk-openai')
    expect(getApiKey('p1')).toBe('sk-openrouter')
    expect(getApiKey('p2')).toBe('sk-openai')
    expect(getApiKey('p3')).toBeUndefined()
  })

  it('clearing one provider does not affect others', () => {
    setApiKey('p1', 'sk-a')
    setApiKey('p2', 'sk-b')
    clearApiKey('p1')
    expect(getApiKey('p1')).toBeUndefined()
    expect(getApiKey('p2')).toBe('sk-b')
  })

  it('overwrites the previous key for the same provider', () => {
    setApiKey('p1', 'first')
    setApiKey('p1', 'second')
    expect(getApiKey('p1')).toBe('second')
  })

  it('clearApiKey is a no-op when no key is set', () => {
    clearApiKey('nonexistent')
    clearApiKey('nonexistent')
    expect(getApiKey('nonexistent')).toBeUndefined()
  })

  it('clearAllKeys removes all provider keys', () => {
    setApiKey('p1', 'sk-a')
    setApiKey('p2', 'sk-b')
    clearAllKeys()
    expect(getApiKey('p1')).toBeUndefined()
    expect(getApiKey('p2')).toBeUndefined()
    expect(hasAnyKey()).toBe(false)
  })

  it('hasAnyKey reflects whether any key is set', () => {
    expect(hasAnyKey()).toBe(false)
    setApiKey('p1', 'sk-a')
    expect(hasAnyKey()).toBe(true)
    clearApiKey('p1')
    expect(hasAnyKey()).toBe(false)
  })

  it('never persists to any storage (ADR-0004: in-memory only)', () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
    const idbOpenSpy = vi.spyOn(indexedDB, 'open')
    const cookieBefore = document.cookie

    setApiKey('p1', 'sk-sensitive')
    getApiKey('p1')
    clearApiKey('p1')

    expect(setItemSpy).not.toHaveBeenCalled()
    expect(idbOpenSpy).not.toHaveBeenCalled()
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
    expect(document.cookie).toBe(cookieBefore)
  })

  it('survives a module re-eval cycle (in-memory, not sessionStorage)', () => {
    setApiKey('p1', 'sk-persistent-across-reload-simulation')
    expect(getApiKey('p1')).toBe('sk-persistent-across-reload-simulation')
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
})
