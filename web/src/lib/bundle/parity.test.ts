/**
 * THE conformance gate (ADR-0013 #1 risk: Rust↔TS format drift).
 *
 * Loads the three archives committed under `crates/synth/tests/fixtures/` —
 * owned by effort 1 (`portable-bundle-format`) — by relative path (NOT copied)
 * and proves this SPA's reader ingests each correctly. The `book-full`
 * assertion is load-bearing: every paragraph's SPA-derived cache key
 * (`audioCacheKey(voice, text)`) MUST equal the key the Rust crate embedded as
 * the audio entry name. If that ever fails, the two implementations have
 * drifted and cross-app audio dedup is broken.
 *
 * A fixture change on the Rust side breaks this test — that is the intended
 * drift signal, not a nuisance. Pair any fixture edit with a TS change in the
 * same commit.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { voiceId } from '../../types'
import { audioCacheKey } from '../audio-cache'
import { UnsupportedBundleKindError } from './errors'
import { readBookBundle } from './reader'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// web/src/lib/bundle/ → up 4 → repo root → crates/synth/tests/fixtures
const FIXTURES = path.resolve(HERE, '../../../../crates/synth/tests/fixtures')

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(FIXTURES, name)))
}

describe("bundle parity — reads the Rust crate's committed fixtures", () => {
  it('book-text-only.taletrek: chapters present, audio absent (text-only bundle)', async () => {
    const bundle = await readBookBundle(fixture('book-text-only.taletrek'))

    expect(bundle.manifest.schemaVersion).toBe(1)
    expect(bundle.manifest.kind).toBe('book')
    expect(bundle.manifest.audio.present).toBe(false)
    expect(bundle.chapters.length).toBeGreaterThan(0)
    expect(bundle.audio.size).toBe(0)
  })

  it("book-full.taletrek: every paragraph's SPA-derived key matches an embedded audio entry", async () => {
    const bundle = await readBookBundle(fixture('book-full.taletrek'))

    expect(bundle.manifest.audio.present).toBe(true)
    expect(bundle.manifest.audio.codec).toBe('opus')

    // The load-bearing parity assertion: rebuild each cache key from
    // (voiceId, paragraphText) on the SPA side and require the set to match
    // the Rust-embedded audio entry keys exactly. Drift = a key mismatch.
    const voice = voiceId(bundle.manifest.book.voiceId)
    const expectedKeys = new Set<string>()
    for (const ch of bundle.chapters) {
      for (const text of ch.paragraphs) {
        if (!text.trim()) continue // Rust skips empty paragraphs at synth time
        expectedKeys.add(await audioCacheKey(voice, text))
      }
    }
    expect(new Set(bundle.audio.keys())).toEqual(expectedKeys)

    // Internal consistency: the manifest's segment count matches what loaded.
    expect(bundle.audio.size).toBe(bundle.manifest.audio.segmentCount)
  })

  it('book-streamed.taletrek: manifest-last streaming fixture — keys + counts still exact', async () => {
    // Written by the Rust `BundleWriter` (streaming-synth) with manifest.json
    // as the LAST entry — proof that name-based JSZip reads are order-blind.
    // The same load-bearing key assertion as book-full applies.
    const bundle = await readBookBundle(fixture('book-streamed.taletrek'))

    expect(bundle.manifest.audio.present).toBe(true)
    expect(bundle.manifest.audio.codec).toBe('opus')

    const voice = voiceId(bundle.manifest.book.voiceId)
    const expectedKeys = new Set<string>()
    for (const ch of bundle.chapters) {
      for (const text of ch.paragraphs) {
        if (!text.trim()) continue
        expectedKeys.add(await audioCacheKey(voice, text))
      }
    }
    // Chapter 2 repeats chapter 1's first paragraph — dedup means 2 segments.
    expect(expectedKeys.size).toBe(2)
    expect(new Set(bundle.audio.keys())).toEqual(expectedKeys)
    expect(bundle.audio.size).toBe(bundle.manifest.audio.segmentCount)
  })

  it('library.taletrek-lib: refused with UnsupportedBundleKindError (library bundles not yet supported)', async () => {
    const err = await readBookBundle(fixture('library.taletrek-lib')).catch((e) => e)
    expect(err).toBeInstanceOf(UnsupportedBundleKindError)
    expect((err as UnsupportedBundleKindError).found).toBe('library')
  })
})
