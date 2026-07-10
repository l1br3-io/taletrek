import { beforeEach, describe, expect, it } from 'vitest'
import { _resetDBForTests, deleteSetting, getSetting, setSetting } from './db'

beforeEach(() => {
  _resetDBForTests()
})

describe('settings store', () => {
  it('round-trips a value through IndexedDB', async () => {
    await setSetting('theme', 'dark')
    expect(await getSetting('theme')).toBe('dark')
  })

  it('returns undefined for a missing key', async () => {
    expect(await getSetting('nope')).toBeUndefined()
  })

  it('overwrites an existing value', async () => {
    await setSetting('voice', 'piper-en')
    await setSetting('voice', 'piper-fr')
    expect(await getSetting('voice')).toBe('piper-fr')
  })

  it('deletes a value', async () => {
    await setSetting('speed', 1.25)
    await deleteSetting('speed')
    expect(await getSetting('speed')).toBeUndefined()
  })

  it('survives a connection reopen (durable across sessions)', async () => {
    await setSetting('position', { chapter: 3, offset: 1024 })
    _resetDBForTests()
    expect(await getSetting('position')).toEqual({ chapter: 3, offset: 1024 })
  })
})
