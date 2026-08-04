import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import pkg from '../../../package.json'
import type { BookBundle, Manifest } from './manifest'
import { readBookBundle } from './reader'
import { writeBookBundle } from './writer'

const VOICE = 'en_US-lessac-medium'
const KEY_A = `${VOICE}:2:${'a'.repeat(64)}`
const KEY_B = `${VOICE}:2:${'b'.repeat(64)}`

/** Minimal valid manifest; the writer overrides generator + audio fields. */
function manifest(): Manifest {
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
    // The writer derives present/codec/segmentCount from the audio map, so these
    // placeholder values are intentionally ignored on the write path.
    audio: { present: false, codec: 'opus', normVersion: 2, segmentCount: 0 },
    generator: { app: 'taletrek-spa', version: 'stale' },
  }
}

function bundle(audio: Map<string, Uint8Array>): BookBundle {
  return {
    manifest: manifest(),
    chapters: [
      { id: 'ch_1', bookId: 'bk_test', index: 0, title: 'One', paragraphs: ['Hello.', 'World.'] },
    ],
    audio,
    meta: {},
  }
}

describe('writeBookBundle — stamping', () => {
  it('stamps generator (taletrek-spa @ package version) on every bundle', async () => {
    const out = await writeBookBundle(bundle(new Map()))
    const read = await readBookBundle(out)
    expect(read.manifest.generator.app).toBe('taletrek-spa')
    expect(read.manifest.generator.version).toBe(pkg.version)
  })

  it('derives audio.present from the audio map size (full when non-empty)', async () => {
    const audio = new Map([
      [KEY_A, new Uint8Array([1, 2])],
      [KEY_B, new Uint8Array([3, 4])],
    ])
    const out = await writeBookBundle(bundle(audio))
    const read = await readBookBundle(out)
    expect(read.manifest.audio.present).toBe(true)
    expect(read.manifest.audio.codec).toBe('opus')
    expect(read.manifest.audio.segmentCount).toBe(2)
    expect(read.manifest.audio.normVersion).toBe(2)
  })

  it('derives audio.present=false for a text-only (empty audio map) bundle', async () => {
    const out = await writeBookBundle(bundle(new Map()))
    const read = await readBookBundle(out)
    expect(read.manifest.audio.present).toBe(false)
    expect(read.manifest.audio.segmentCount).toBe(0)
  })
})

describe('writeBookBundle → readBookBundle round-trip', () => {
  it('preserves chapters + audio keys + audio bytes (full bundle)', async () => {
    const audio = new Map([
      [KEY_A, new Uint8Array([1, 2, 3])],
      [KEY_B, new Uint8Array([4, 5, 6])],
    ])
    const out = await writeBookBundle(bundle(audio))
    const read = await readBookBundle(out)

    expect(read.chapters).toHaveLength(1)
    expect(read.chapters[0]?.paragraphs).toEqual(['Hello.', 'World.'])
    expect(new Set(read.audio.keys())).toEqual(new Set([KEY_A, KEY_B]))
    expect(Array.from(read.audio.get(KEY_A) ?? [])).toEqual([1, 2, 3])
    expect(Array.from(read.audio.get(KEY_B) ?? [])).toEqual([4, 5, 6])
  })

  it('emits audio entries as audio/<key>.opus', async () => {
    const audio = new Map([['somekey', new Uint8Array([9])]])
    const out = await writeBookBundle(bundle(audio))
    const zip = await JSZip.loadAsync(out)
    const names = Object.entries(zip.files)
      .filter(([n, f]) => n.startsWith('audio/') && !f.dir)
      .map(([n]) => n)
    expect(names).toEqual(['audio/somekey.opus'])
  })

  it('emits no audio/ entries for a text-only bundle', async () => {
    const out = await writeBookBundle(bundle(new Map()))
    const zip = await JSZip.loadAsync(out)
    const names = Object.entries(zip.files)
      .filter(([n, f]) => n.startsWith('audio/') && !f.dir)
      .map(([n]) => n)
    expect(names).toEqual([])
  })

  it('round-trips all three meta/* entries when present', async () => {
    const b = bundle(new Map())
    b.meta = {
      source: { filename: 'book.epub', format: 'epub' },
      position: { chapterIndex: 2, paragraphIndex: 5 },
    }
    const read = await readBookBundle(await writeBookBundle(b))
    expect(read.meta.source).toEqual({ filename: 'book.epub', format: 'epub' })
    expect(read.meta.position).toEqual({ chapterIndex: 2, paragraphIndex: 5 })
    expect(read.meta.processing).toBeUndefined()
  })

  it('omits every meta/* entry when none are present', async () => {
    const out = await writeBookBundle(bundle(new Map()))
    const zip = await JSZip.loadAsync(out)
    const names = Object.entries(zip.files)
      .filter(([n, f]) => n.startsWith('meta/') && !f.dir)
      .map(([n]) => n)
    expect(names).toEqual([])
  })

  it('preserves book fields (title, voiceId, sourceFormat, …) through the round-trip', async () => {
    const out = await writeBookBundle(bundle(new Map()))
    const read = await readBookBundle(out)
    expect(read.manifest.book.title).toBe('Test')
    expect(read.manifest.book.voiceId).toBe(VOICE)
    expect(read.manifest.book.sourceFormat).toBe('txt')
    expect(read.manifest.kind).toBe('book')
    expect(read.manifest.schemaVersion).toBe(1)
  })
})
