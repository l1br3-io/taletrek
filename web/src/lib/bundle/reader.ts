/**
 * Pure `bytes → BookBundle` reader for the frozen v1 `.taletrek` book-bundle
 * format ([`docs/bundle-format.md`](../../../../docs/bundle-format.md)). Unzips
 * with `jszip`, parses + validates the manifest, and returns a structured
 * in-memory {@link BookBundle}. No IDB, no DOM.
 *
 * Semantics mirror the Rust reference reader (`crates/synth/src/bundle/io.rs`)
 * so the two implementations stay conformant — the SPA's `parity.test.ts` is
 * the drift gate. Two TS-specific additions (neither fires on real desktop
 * output): the `kind: "library"` refusal (the SPA has no library reader) and
 * a narrow codec guard (refuses a manifest declaring a codec the SPA can't
 * play; Opus/M4A/WAV all pass).
 */

import JSZip from 'jszip'
import {
  CorruptBundleError,
  UnsupportedAudioCodecError,
  UnsupportedBundleKindError,
  UnsupportedSchemaVersionError,
} from './errors'
import {
  type AudioCodec,
  type BookBundle,
  MANIFEST_SCHEMA_VERSION,
  type Manifest,
  type PositionMeta,
  type ProcessingMeta,
  READABLE_AUDIO_CODECS,
  type SourceMeta,
  type TextJson,
} from './manifest'

const MANIFEST_ENTRY = 'manifest.json'
const TEXT_ENTRY = 'text.json'
const AUDIO_PREFIX = 'audio/'

/**
 * Loose shape used only for pre-cast validation: enough to read `schemaVersion`,
 * `kind`, and `audio.codec` defensively before committing to the full
 * {@link Manifest} type. A library manifest, for example, legitimately lacks
 * `book`/`audio` — this shape must not assume them.
 */
type RawManifest = {
  schemaVersion?: unknown
  kind?: unknown
  audio?: { codec?: unknown }
}

/**
 * Read a `.taletrek` book bundle from raw bytes. Accepts text-only and full
 * bundles; refuses unknown schema versions, library bundles, and unsupported
 * audio codecs with typed errors (never best-effort loads).
 */
export async function readBookBundle(input: Uint8Array): Promise<BookBundle> {
  const zip = await loadZip(input)
  const raw = await readRequiredJson<RawManifest>(zip, MANIFEST_ENTRY)

  // Schema gate first: a newer format is never best-effort loaded. Read before
  // any field access so a v2 manifest's unknown shape can't confuse later code.
  const schemaVersion = raw.schemaVersion
  if (schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(typeof schemaVersion === 'number' ? schemaVersion : 0, [
      MANIFEST_SCHEMA_VERSION,
    ])
  }

  // Kind gate before any book/audio access: a *library* manifest legitimately
  // has no `book` or `audio` fields, so touching them would crash rather than
  // refuse cleanly.
  if (raw.kind !== undefined && raw.kind !== 'book') {
    throw new UnsupportedBundleKindError(raw.kind as string)
  }

  // Narrow TS-specific codec guard. The Rust reader infers codec per-entry and
  // never reads `manifest.audio.codec`; the SPA additionally refuses a declared
  // codec it can't play. Never fires on real desktop (Opus) output — only on a
  // hand-crafted bundle with a nonsense codec.
  const declaredCodec = raw.audio?.codec
  if (declaredCodec !== undefined && !READABLE_AUDIO_CODECS.includes(declaredCodec as AudioCodec)) {
    throw new UnsupportedAudioCodecError(declaredCodec as string)
  }

  const text = await readRequiredJson<TextJson>(zip, TEXT_ENTRY)
  const manifest = raw as unknown as Manifest

  // Audio scan only when the manifest declares it present (parity with Rust).
  // Entries with an unrecognized extension are silently skipped (parity).
  const audio = new Map<string, Uint8Array>()
  if (manifest.audio.present) {
    for (const [name, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue
      if (!name.startsWith(AUDIO_PREFIX)) continue
      const rest = name.slice(AUDIO_PREFIX.length)
      const dot = rest.lastIndexOf('.')
      if (dot < 0) continue
      const key = rest.slice(0, dot)
      const ext = rest.slice(dot + 1).toLowerCase()
      if (!READABLE_AUDIO_CODECS.includes(ext as AudioCodec)) continue
      audio.set(key, await entry.async('uint8array'))
    }
  }

  const source = await readOptionalJson<SourceMeta>(zip, 'meta/source.json')
  const processing = await readOptionalJson<ProcessingMeta>(zip, 'meta/processing.json')
  const position = await readOptionalJson<PositionMeta>(zip, 'meta/position.json')

  return { manifest, chapters: text.chapters, audio, meta: { source, processing, position } }
}

/** Unzip; any structural failure (truncated, not a ZIP) → CorruptBundleError. */
async function loadZip(input: Uint8Array): Promise<JSZip> {
  try {
    return await JSZip.loadAsync(input)
  } catch {
    throw new CorruptBundleError('not a valid ZIP archive')
  }
}

/** Read + JSON-parse a required entry. Missing entry or bad JSON → CorruptBundleError. */
async function readRequiredJson<T>(zip: JSZip, name: string): Promise<T> {
  const entry = zip.file(name)
  if (!entry) throw new CorruptBundleError(`missing ${name}`)
  try {
    return JSON.parse(await entry.async('text')) as T
  } catch {
    throw new CorruptBundleError(`${name} is not valid JSON`)
  }
}

/** Read + JSON-parse an optional entry. Missing → undefined; present + bad JSON → CorruptBundleError. */
async function readOptionalJson<T>(zip: JSZip, name: string): Promise<T | undefined> {
  const entry = zip.file(name)
  if (!entry) return undefined
  try {
    return JSON.parse(await entry.async('text')) as T
  } catch {
    throw new CorruptBundleError(`${name} is not valid JSON`)
  }
}
