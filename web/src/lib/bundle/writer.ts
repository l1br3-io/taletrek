/**
 * Pure `BookBundle → bytes` writer — the inverse of {@link readBookBundle}.
 * Produces a `.taletrek` ZIP the reader reads back (see `writer.test.ts`
 * round-trip), conforming to [`docs/bundle-format.md`](../../../../docs/bundle-format.md) v1.
 *
 * The writer **owns** the generator + audio stamping: it derives
 * `audio.present`/`segmentCount` from the audio map size, pins `codec` to the
 * v1 Opus default, and stamps `generator = taletrek-spa @ <package version>`.
 * Callers (export.ts) supply the book fields + chapters + audio + meta; they do
 * not need to produce a fully-stamped manifest. (The Rust writer trusts the
 * manifest verbatim because the desktop's `synth_and_stamp` pre-stamps it; the
 * SPA splits responsibilities differently, which is an internal choice that
 * does not affect format parity.)
 */

import JSZip from 'jszip'
import pkg from '../../../package.json'
import { NORM_VERSION } from '../tts/normalize'
import {
  type BookBundle,
  MANIFEST_SCHEMA_VERSION,
  type Manifest,
  SPA_GENERATOR_APP,
  type TextJson,
  WRITABLE_AUDIO_CODEC,
} from './manifest'

const MANIFEST_ENTRY = 'manifest.json'
const TEXT_ENTRY = 'text.json'
const AUDIO_PREFIX = 'audio/'
const META_PREFIX = 'meta/'

/**
 * Serialize a {@link BookBundle} to a `.taletrek` ZIP. Stamps the manifest's
 * generator + audio fields; passes the book fields, chapters, and meta through
 * unchanged. Emits `meta/*` only for the entries actually present.
 */
export async function writeBookBundle(bundle: BookBundle): Promise<Uint8Array> {
  const segmentCount = bundle.audio.size
  const manifest: Manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    kind: 'book',
    book: bundle.manifest.book,
    audio: {
      present: segmentCount > 0,
      codec: WRITABLE_AUDIO_CODEC,
      normVersion: Number(NORM_VERSION),
      segmentCount,
    },
    generator: { app: SPA_GENERATOR_APP, version: pkg.version },
  }

  const text: TextJson = { schemaVersion: MANIFEST_SCHEMA_VERSION, chapters: bundle.chapters }

  const zip = new JSZip()
  zip.file(MANIFEST_ENTRY, JSON.stringify(manifest, null, 2))
  zip.file(TEXT_ENTRY, JSON.stringify(text, null, 2))
  for (const [key, bytes] of bundle.audio) {
    zip.file(`${AUDIO_PREFIX}${key}.${WRITABLE_AUDIO_CODEC}`, bytes)
  }
  if (bundle.meta.source) {
    zip.file(`${META_PREFIX}source.json`, JSON.stringify(bundle.meta.source, null, 2))
  }
  if (bundle.meta.processing) {
    zip.file(`${META_PREFIX}processing.json`, JSON.stringify(bundle.meta.processing, null, 2))
  }
  if (bundle.meta.position) {
    zip.file(`${META_PREFIX}position.json`, JSON.stringify(bundle.meta.position, null, 2))
  }

  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
}
