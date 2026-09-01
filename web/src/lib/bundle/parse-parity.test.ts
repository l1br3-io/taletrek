/**
 * TS side of the clean-at-parse mirror contract (kernel-parse T12).
 *
 * `crates/parse/src/clean.rs` is a byte-faithful port of this SPA's M4
 * filters, so parse output is canonical clean text: whatever the reader's
 * derived `cleanChapters` does to those paragraphs must leave them
 * unchanged — otherwise the reader's text no longer matches the cache key
 * the audio was synthesized under and playback dies on a cache miss (G22).
 * The Rust side pins `clean_book(parse(x)) == parse(x)`; this test pins the
 * same invariant from the TS side, through the full import path.
 *
 * The fixture is a real parse-produced bundle (built by `just parse-fixture`
 * from `crates/parse/testdata/plain.txt`, whose raw text exercises every M4
 * filter — URLs, footnote refs/defs, images, page numbers). A change to the
 * Rust parse/clean output breaks this test — that is the intended drift
 * signal, not a nuisance. Regenerate with
 * `just parse-fixture && cp /tmp/plain.taletrek crates/parse/testdata/`.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { cleanChapters } from '../clean'
import { DEFAULT_CLEANING } from '../clean/types'
import { _clearDBForTests, _resetDBForTests, getChaptersByBook } from '../db'
import { importBookBundle } from './import'
import { readBookBundle } from './reader'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// web/src/lib/bundle/ → up 4 → repo root → crates/parse/testdata
const TESTDATA = path.resolve(HERE, '../../../../crates/parse/testdata')

beforeEach(async () => {
  _resetDBForTests()
  await _clearDBForTests()
})

describe('parse parity — the reader clean never alters parse output', () => {
  it('cleanChapters(DEFAULT_CLEANING) is the identity on an imported parse-produced bundle', async () => {
    const bytes = new Uint8Array(readFileSync(path.join(TESTDATA, 'plain.taletrek')))
    const bundle = await readBookBundle(bytes)
    const result = await importBookBundle(bundle)
    const chapters = await getChaptersByBook(result.bookId)

    // The fixture's raw source exercised every M4 filter (urls, images,
    // footnotes, page numbers) and parse already removed them — so this
    // identity has real work to do, not just echo clean input.
    expect(chapters.length).toBeGreaterThan(0)
    expect(chapters.length).toBe(bundle.chapters.length)
    expect(cleanChapters(chapters, DEFAULT_CLEANING)).toEqual(chapters)

    // Identity holds against the wire paragraphs too, not just the IDB
    // copies — nothing shifted between read, import, and clean.
    for (const [i, ch] of chapters.entries()) {
      expect(ch.paragraphs).toEqual(bundle.chapters[i]?.paragraphs)
    }
  })
})
