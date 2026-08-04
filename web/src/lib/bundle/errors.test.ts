import { describe, expect, it } from 'vitest'
import {
  BundleError,
  BundleTooLargeError,
  CorruptBundleError,
  UnsupportedAudioCodecError,
  UnsupportedBundleKindError,
  UnsupportedSchemaVersionError,
} from './errors'

describe('BundleError hierarchy', () => {
  it('every concrete error is an instance of the BundleError base', () => {
    const errors = [
      new UnsupportedSchemaVersionError(2, [1]),
      new CorruptBundleError('missing manifest.json'),
      new UnsupportedBundleKindError('library'),
      new UnsupportedAudioCodecError('mp3'),
      new BundleTooLargeError(),
    ]
    for (const err of errors) {
      expect(err).toBeInstanceOf(BundleError)
      expect(err).toBeInstanceOf(Error)
    }
  })

  it('each subclass overrides `name` (the UI discriminator)', () => {
    expect(new UnsupportedSchemaVersionError(2, [1]).name).toBe('UnsupportedSchemaVersionError')
    expect(new CorruptBundleError('x').name).toBe('CorruptBundleError')
    expect(new UnsupportedBundleKindError('library').name).toBe('UnsupportedBundleKindError')
    expect(new UnsupportedAudioCodecError('mp3').name).toBe('UnsupportedAudioCodecError')
    expect(new BundleTooLargeError().name).toBe('BundleTooLargeError')
  })

  it('UnsupportedSchemaVersionError carries the found + supported values', () => {
    const err = new UnsupportedSchemaVersionError(2, [1])
    expect(err.found).toBe(2)
    expect(err.supported).toEqual([1])
    expect(err.message).toContain('2')
    expect(err.message).toContain('1')
  })

  it('UnsupportedBundleKindError message points at the library-bundle refusal', () => {
    const err = new UnsupportedBundleKindError('library')
    expect(err.found).toBe('library')
    expect(err.message).toContain('library')
  })

  it('UnsupportedAudioCodecError carries the offending codec', () => {
    const err = new UnsupportedAudioCodecError('mp3')
    expect(err.found).toBe('mp3')
    expect(err.message).toContain('mp3')
  })

  it('BundleTooLargeError message mirrors the BackupTooLargeError shape', () => {
    const err = new BundleTooLargeError()
    expect(err.message).toMatch(/storage quota/i)
  })
})
