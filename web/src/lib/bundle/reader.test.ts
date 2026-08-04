import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import {
  CorruptBundleError,
  UnsupportedAudioCodecError,
  UnsupportedBundleKindError,
  UnsupportedSchemaVersionError,
} from './errors'
import type { Manifest, TextJson } from './manifest'
import { readBookBundle } from './reader'

/** Build a ZIP from a path → content map (string or bytes). Returns the archive bytes. */
async function buildZip(entries: Record<string, string | Uint8Array>): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const [path, content] of Object.entries(entries)) {
    zip.file(path, content)
  }
  return zip.generateAsync({ type: 'uint8array' })
}

const VOICE = 'en_US-lessac-medium'
const KEY_A = `${VOICE}:2:${'a'.repeat(64)}`
const KEY_B = `${VOICE}:2:${'b'.repeat(64)}`

function manifest(opts: Partial<Manifest> = {}): Manifest {
  return {
    schemaVersion: 1,
    kind: 'book',
    book: {
      id: 'bk_test',
      title: 'Test',
      sourceFormat: 'txt',
      chapterCount: 1,
      voiceId: VOICE,
      createdAt: 0,
      updatedAt: 0,
    },
    audio: { present: false, codec: 'opus', normVersion: 2, segmentCount: 0 },
    generator: { app: 'taletrek-spa', version: '0.0.0' },
    ...opts,
  }
}

function text(): TextJson {
  return {
    schemaVersion: 1,
    chapters: [
      { id: 'ch_1', bookId: 'bk_test', index: 0, title: 'One', paragraphs: ['Hello.', 'World.'] },
    ],
  }
}

describe('readBookBundle — happy paths', () => {
  it('reads a full bundle: chapters + every audio entry keyed by cache key', async () => {
    const bytes = await buildZip({
      'manifest.json': JSON.stringify(
        manifest({ audio: { present: true, codec: 'opus', normVersion: 2, segmentCount: 2 } }),
      ),
      'text.json': JSON.stringify(text()),
      [`audio/${KEY_A}.opus`]: new Uint8Array([1, 2, 3]),
      [`audio/${KEY_B}.opus`]: new Uint8Array([4, 5, 6]),
    })

    const bundle = await readBookBundle(bytes)

    expect(bundle.manifest.kind).toBe('book')
    expect(bundle.chapters).toHaveLength(1)
    expect(bundle.chapters[0]?.paragraphs).toEqual(['Hello.', 'World.'])
    expect(bundle.audio.size).toBe(2)
    expect(Array.from(bundle.audio.get(KEY_A) ?? [])).toEqual([1, 2, 3])
    expect(Array.from(bundle.audio.get(KEY_B) ?? [])).toEqual([4, 5, 6])
  })

  it('reads a text-only bundle (audio.present=false, no audio/ entries) → empty audio map', async () => {
    const bytes = await buildZip({
      'manifest.json': JSON.stringify(manifest()),
      'text.json': JSON.stringify(text()),
    })

    const bundle = await readBookBundle(bytes)

    expect(bundle.manifest.audio.present).toBe(false)
    expect(bundle.audio.size).toBe(0)
  })

  it('parses meta/* when present', async () => {
    const bytes = await buildZip({
      'manifest.json': JSON.stringify(manifest()),
      'text.json': JSON.stringify(text()),
      'meta/source.json': JSON.stringify({ filename: 'book.epub', format: 'epub' }),
      'meta/processing.json': JSON.stringify({ defIds: [], label: 'raw' }),
      'meta/position.json': JSON.stringify({ chapterIndex: 3, paragraphIndex: 12 }),
    })

    const bundle = await readBookBundle(bytes)

    expect(bundle.meta.source).toEqual({ filename: 'book.epub', format: 'epub' })
    expect(bundle.meta.position).toEqual({ chapterIndex: 3, paragraphIndex: 12 })
    expect(bundle.meta.processing).toBeDefined()
  })

  it('omits meta/* when absent (all undefined)', async () => {
    const bytes = await buildZip({
      'manifest.json': JSON.stringify(manifest()),
      'text.json': JSON.stringify(text()),
    })
    const bundle = await readBookBundle(bytes)
    expect(bundle.meta.source).toBeUndefined()
    expect(bundle.meta.processing).toBeUndefined()
    expect(bundle.meta.position).toBeUndefined()
  })
})

describe('readBookBundle — refusal paths', () => {
  it('refuses a truncated / non-ZIP input with CorruptBundleError', async () => {
    await expect(readBookBundle(new Uint8Array([0, 1, 2, 3]))).rejects.toBeInstanceOf(
      CorruptBundleError,
    )
  })

  it('refuses a missing manifest.json with CorruptBundleError', async () => {
    const bytes = await buildZip({ 'text.json': JSON.stringify(text()) })
    await expect(readBookBundle(bytes)).rejects.toBeInstanceOf(CorruptBundleError)
  })

  it('refuses a missing text.json with CorruptBundleError', async () => {
    const bytes = await buildZip({ 'manifest.json': JSON.stringify(manifest()) })
    await expect(readBookBundle(bytes)).rejects.toBeInstanceOf(CorruptBundleError)
  })

  it('refuses schemaVersion: 2 with UnsupportedSchemaVersionError', async () => {
    const bytes = await buildZip({
      'manifest.json': JSON.stringify(manifest({ schemaVersion: 2 as Manifest['schemaVersion'] })),
      'text.json': JSON.stringify(text()),
    })
    const err = await readBookBundle(bytes).catch((e) => e)
    expect(err).toBeInstanceOf(UnsupportedSchemaVersionError)
    expect((err as UnsupportedSchemaVersionError).found).toBe(2)
  })

  it('refuses a missing schemaVersion with UnsupportedSchemaVersionError (never best-effort loads)', async () => {
    const m = manifest()
    const { schemaVersion: _omit, ...rest } = m
    void _omit
    const bytes = await buildZip({
      'manifest.json': JSON.stringify(rest),
      'text.json': JSON.stringify(text()),
    })
    await expect(readBookBundle(bytes)).rejects.toBeInstanceOf(UnsupportedSchemaVersionError)
  })

  it('refuses kind: "library" with UnsupportedBundleKindError (before touching book/audio)', async () => {
    // A library manifest has NO book/audio fields — the kind gate must fire first.
    const bytes = await buildZip({
      'manifest.json': JSON.stringify({ schemaVersion: 1, kind: 'library', exportedAt: 0 }),
      'library-manifest.json': JSON.stringify({ schemaVersion: 1, kind: 'library' }),
    })
    const err = await readBookBundle(bytes).catch((e) => e)
    expect(err).toBeInstanceOf(UnsupportedBundleKindError)
    expect((err as UnsupportedBundleKindError).found).toBe('library')
  })

  it('refuses an unsupported declared codec with UnsupportedAudioCodecError', async () => {
    const bytes = await buildZip({
      'manifest.json': JSON.stringify(
        manifest({
          audio: {
            present: true,
            codec: 'mp3' as Manifest['audio']['codec'],
            normVersion: 2,
            segmentCount: 1,
          },
        }),
      ),
      'text.json': JSON.stringify(text()),
    })
    const err = await readBookBundle(bytes).catch((e) => e)
    expect(err).toBeInstanceOf(UnsupportedAudioCodecError)
    expect((err as UnsupportedAudioCodecError).found).toBe('mp3')
  })
})

describe('readBookBundle — audio scanning details', () => {
  it('does NOT scan audio entries when audio.present is false (parity with Rust reader)', async () => {
    // A stray audio entry in a text-only bundle is ignored, not loaded.
    const bytes = await buildZip({
      'manifest.json': JSON.stringify(manifest()), // present: false
      'text.json': JSON.stringify(text()),
      [`audio/${KEY_A}.opus`]: new Uint8Array([9, 9]),
    })
    const bundle = await readBookBundle(bytes)
    expect(bundle.audio.size).toBe(0)
  })

  it('skips audio entries with an unrecognized extension (parity: silent skip, not an error)', async () => {
    const bytes = await buildZip({
      'manifest.json': JSON.stringify(
        manifest({ audio: { present: true, codec: 'opus', normVersion: 2, segmentCount: 1 } }),
      ),
      'text.json': JSON.stringify(text()),
      [`audio/${KEY_A}.opus`]: new Uint8Array([1, 2]),
      [`audio/${KEY_B}.mp3`]: new Uint8Array([3, 4]), // unknown ext → skipped
    })
    const bundle = await readBookBundle(bytes)
    expect(bundle.audio.size).toBe(1)
    expect(bundle.audio.has(KEY_A)).toBe(true)
    expect(bundle.audio.has(KEY_B)).toBe(false)
  })
})
