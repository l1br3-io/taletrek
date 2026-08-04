/**
 * TS mirror of the frozen v1 `.taletrek` bundle format
 * ([`docs/bundle-format.md`](../../../../docs/bundle-format.md)). This module
 * owns the wire shapes only — no ZIP, no IDB. The reader/writer (bytes) and
 * import/export (IDB) layers build on top of these types.
 *
 * Field names match the camelCase JSON exactly. IDs come in as plain strings
 * on the wire; the SPA's branded-id types (`BookId`/`ChapterId`/`VoiceId`) are
 * attached by the conversion helpers below, **not** by these interfaces.
 */

import type { BookId, Chapter, ChapterId } from '../../types'
import type { AppliedProcessing } from '../ai/types'

/** Bundle format schema version this SPA reads + writes. Frozen at v1. */
export const MANIFEST_SCHEMA_VERSION = 1 as const
export type ManifestSchemaVersion = typeof MANIFEST_SCHEMA_VERSION

/** Versions a reader will accept; surfaces in the `UnsupportedSchemaVersionError` message. */
export const SUPPORTED_SCHEMA_VERSIONS: readonly ManifestSchemaVersion[] = [MANIFEST_SCHEMA_VERSION]

/** `manifest.kind` — the archive's top-level shape. Only `"book"` is supported in this effort. */
export type ManifestKind = 'book' | 'library'

/**
 * Audio codec enumeration (`bundle-format.md` §Conformance). Opus is the v1
 * default; M4A is permitted (iOS-native); WAV is permitted but discouraged.
 */
export type AudioCodec = 'opus' | 'm4a' | 'wav'

/** Codecs a reader MUST accept. The writer is Opus-only for v1 (see below). */
export const READABLE_AUDIO_CODECS: readonly AudioCodec[] = ['opus', 'm4a', 'wav']

/** Codec the SPA writer emits for v1 (format doc default; best size/quality for speech). */
export const WRITABLE_AUDIO_CODEC: AudioCodec = 'opus'

/** `generator.app` enumeration — which TaleTrek app produced the archive. */
export type GeneratorApp = 'taletrek-spa' | 'taletrek-desktop' | 'taletrek-server'

/** Generator tag the SPA stamps on every bundle it writes. */
export const SPA_GENERATOR_APP: GeneratorApp = 'taletrek-spa'

/**
 * `manifest.book.sourceFormat`. Note the SPA's own `BookFormat` has no
 * `"unknown"`; import maps `unknown → "txt"` (least-lossy default). See
 * `import.ts` + `docs/gotchas.md` (G28).
 */
export type BundleSourceFormat = 'pdf' | 'epub' | 'mobi' | 'txt' | 'md' | 'unknown'

/** `manifest.book` — the book-level descriptor. */
export interface BookMeta {
  /**
   * Originating book's TaleTrek BookId. Informational only: the importer
   * allocates a fresh id on every import (never reuses), per
   * `bundle-format.md` §Conformance.
   */
  id: string
  title: string
  author?: string
  sourceFormat: BundleSourceFormat
  chapterCount: number
  /** Voice the audio (if present) was synthesized under. Namespaces the cache key. */
  voiceId: string
  /** ms since epoch. */
  createdAt: number
  /** ms since epoch. */
  updatedAt: number
  /** 0..1 — optional reading-progress hint. */
  progressFraction?: number
}

/** `manifest.audio` — describes the audio payload, or its absence. */
export interface AudioMeta {
  /** `false` (or missing `audio/`) → text-only bundle (pre-synth). */
  present: boolean
  codec: AudioCodec
  /** Matches the cache-key `NORM_VERSION` the synthesizer used. */
  normVersion: number
  /** Stored entry count (after dedup), not raw paragraph count. */
  segmentCount: number
}

/** `manifest.generator` — which app wrote this archive. */
export interface Generator {
  app: GeneratorApp
  version: string
}

/** `manifest.json` — the top-level bundle manifest. */
export interface Manifest {
  schemaVersion: ManifestSchemaVersion
  kind: ManifestKind
  book: BookMeta
  audio: AudioMeta
  generator: Generator
}

/** Sub-heading within a chapter, in the wire shape (identical to the SPA's `ChapterHeading`). */
export interface ChapterTextHeading {
  paragraphIndex: number
  title: string
}

/** A chapter in `text.json` wire shape. IDs are plain strings on the wire. */
export interface ChapterText {
  id: string
  bookId: string
  index: number
  title: string
  paragraphs: string[]
  /** Optional (M10 outline); absent on older books. */
  headings?: ChapterTextHeading[]
}

/** `text.json`. */
export interface TextJson {
  schemaVersion: ManifestSchemaVersion
  chapters: ChapterText[]
}

/** `meta/source.json` — original-file provenance (the raw file is NOT embedded). */
export interface SourceMeta {
  filename: string
  format: BundleSourceFormat
  sha256?: string
}

/**
 * `meta/position.json` — last reading place. Structurally identical to the
 * SPA's `BookPosition`, kept as its own type so the wire shape is explicit.
 */
export interface PositionMeta {
  chapterIndex: number
  paragraphIndex: number
}

/** `meta/processing.json` reuses the SPA's `AppliedProcessing` (M6) verbatim. */
export type ProcessingMeta = AppliedProcessing

/**
 * The in-memory aggregate a reader produces / a writer consumes. Audio values
 * are raw bytes (`Uint8Array`); the importer converts to `Blob` for the
 * `audioCache` IDB store.
 */
export interface BookBundle {
  manifest: Manifest
  chapters: ChapterText[]
  /** Keyed by the content-addressed cache key (`${voiceId}:${NORM_VERSION}:${sha256}`). */
  audio: Map<string, Uint8Array>
  meta: {
    source?: SourceMeta
    processing?: ProcessingMeta
    position?: PositionMeta
  }
}

/**
 * Map a wire `ChapterText` onto the SPA's `Chapter` using the provided branded
 * ids. The importer allocates fresh ids (collision-safe); the exporter passes
 * the existing book/chapter ids. Paragraphs, headings, index, and title pass
 * through unchanged.
 */
export function chapterTextToChapter(
  ct: ChapterText,
  ids: { bookId: BookId; chapterId: ChapterId },
): Chapter {
  return {
    id: ids.chapterId,
    bookId: ids.bookId,
    index: ct.index,
    title: ct.title,
    paragraphs: ct.paragraphs,
    ...(ct.headings !== undefined ? { headings: ct.headings } : {}),
  }
}

/**
 * Map a SPA `Chapter` onto the wire `ChapterText` shape. Inverse of
 * {@link chapterTextToChapter}. Used by the exporter.
 */
export function chapterToChapterText(ch: Chapter): ChapterText {
  return {
    id: ch.id,
    bookId: ch.bookId,
    index: ch.index,
    title: ch.title,
    paragraphs: ch.paragraphs,
    ...(ch.headings !== undefined ? { headings: ch.headings } : {}),
  }
}
