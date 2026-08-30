/**
 * IDB ingest seam for `.taletrek` book bundles. Takes a {@link BookBundle}
 * (produced by {@link readBookBundle}) and writes it into the SPA's existing
 * IndexedDB stores so the imported book becomes a first-class library entry
 * that plays immediately — no re-synthesis, no parsing.
 *
 * Collision policy: **always allocate fresh ids** (`bundle-format.md`
 * §Conformance). Re-importing the same bundle creates a second book; the
 * importer never overwrites an existing `BookId` or `ChapterId`. The bundle's
 * original ids are informational only (they record provenance on the source
 * device) and are dropped on the floor.
 *
 * Audio dedup is automatic: each `audio/` entry's key is the SPA's
 * content-addressed cache key (`${voiceId}:${NORM_VERSION}:${sha256}`), so a
 * paragraph already cached under the same voice is skipped — no duplicate
 * write, no size growth. This is what lets a desktop-synthed bundle share
 * audio with on-device-synthed audio for free.
 */

import type { Book, BookFormat, BookId } from '../../types'
import { newBookId, newChapterId, voiceId } from '../../types'
import { getAudioCacheEntry, putAudioCacheEntry, putBook, putBookFile, putChapters } from '../db'
import { BundleTooLargeError } from './errors'
import type { AudioCodec, BookBundle, BundleSourceFormat } from './manifest'
import { chapterTextToChapter } from './manifest'

/** Result of a successful import — the new book's id + counts of what landed. */
export interface ImportBundleResult {
  /** Freshly allocated id of the imported book. */
  bookId: BookId
  /** Counts of what was written. `audio` reflects only genuinely-new entries (dedup skips cached ones). */
  imported: { chapters: number; audio: number }
}

/**
 * Map a bundle `sourceFormat` onto the SPA's `BookFormat`. The SPA type has no
 * `"unknown"` variant, so an unknown source collapses to `'txt'` — the
 * least-lossy default (plain text is the lowest-common-denominator input the
 * reader can always display).
 *
 * GOTCHA (G28, `docs/gotchas.md#g28`): `bundle-format.md` permits
 * `sourceFormat: "unknown"` (a desktop synth may not know the original file
 * type); the SPA's `BookFormat` union does not. Mapping to `'txt'` keeps the
 * book playable. The side effect is that a round-trip `epub → unknown → txt`
 * is lossy on the format label only — the text is already cleaned upstream.
 */
function sourceFormatToBookFormat(sf: BundleSourceFormat): BookFormat {
  switch (sf) {
    case 'pdf':
    case 'epub':
    case 'mobi':
    case 'txt':
    case 'md':
      return sf
    case 'unknown':
      return 'txt'
  }
}

/** MIME for the cache blob, derived from the manifest's declared audio codec. */
function audioCodecMime(codec: AudioCodec): string {
  switch (codec) {
    case 'opus':
      return 'audio/ogg'
    case 'm4a':
      return 'audio/mp4'
    case 'wav':
      return 'audio/wav'
  }
}

/** MIME for the BookFile provenance record, derived from the source format. */
function sourceFormatMime(sf: BundleSourceFormat): string {
  switch (sf) {
    case 'pdf':
      return 'application/pdf'
    case 'epub':
      return 'application/epub+zip'
    case 'mobi':
      return 'application/x-mobipocket-ebook'
    case 'txt':
      return 'text/plain'
    case 'md':
      return 'text/markdown'
    case 'unknown':
      return 'application/octet-stream'
  }
}

/**
 * Estimate the bundle's IDB footprint: audio bytes (exact) + chapter text
 * chars (UTF-16 code-unit count — a close-enough proxy for the pre-flight
 * guard; erring slightly low is acceptable since it's a quota guard, not
 * accounting).
 */
function bundleFootprint(bundle: BookBundle): number {
  let bytes = 0
  for (const [, arr] of bundle.audio) bytes += arr.length
  for (const ch of bundle.chapters) {
    for (const p of ch.paragraphs) bytes += p.length
    bytes += ch.title.length
  }
  return bytes
}

/** Best-effort `navigator.storage.estimate()`; `undefined` when unavailable. */
async function getStorageEstimate(): Promise<{ quota?: number; usage?: number } | undefined> {
  if (typeof navigator === 'undefined') return undefined
  const storage = (navigator as Navigator).storage
  if (!storage?.estimate) return undefined
  try {
    return await storage.estimate()
  } catch {
    return undefined
  }
}

/**
 * Pre-flight quota guard. Throws {@link BundleTooLargeError} before any IDB
 * write when the bundle's estimated footprint would exceed the device's
 * remaining storage quota. Mirrors `backup.ts`'s `BackupTooLargeError` UX.
 * Silent no-op when the Storage API is unavailable (can't estimate → proceed).
 */
async function assertQuotaForBundle(bundle: BookBundle): Promise<void> {
  const estimate = await getStorageEstimate()
  if (estimate === undefined) return
  const quota = estimate.quota ?? 0
  const usage = estimate.usage ?? 0
  const remaining = quota - usage
  if (bundleFootprint(bundle) > remaining) {
    throw new BundleTooLargeError()
  }
}

/**
 * Import a {@link BookBundle} into the SPA's IndexedDB stores. Allocates a
 * fresh `BookId` + fresh `ChapterId`s (never reuses the bundle's ids), writes
 * the book + chapters, flows audio into the content-addressed `audioCache`
 * (skipping already-cached entries), and restores `meta/{source,processing,position}`
 * onto the matching `Book` fields / `files` store. Pre-flights the storage
 * quota and throws {@link BundleTooLargeError} before writing anything on
 * insufficient space.
 */
export async function importBookBundle(bundle: BookBundle): Promise<ImportBundleResult> {
  await assertQuotaForBundle(bundle)

  const bookId = newBookId()

  const book: Book = {
    id: bookId,
    title: bundle.manifest.book.title,
    format: sourceFormatToBookFormat(bundle.manifest.book.sourceFormat),
    chapterCount: bundle.chapters.length,
    createdAt: bundle.manifest.book.createdAt,
    updatedAt: bundle.manifest.book.updatedAt,
    voiceId: voiceId(bundle.manifest.book.voiceId),
    ...(bundle.meta.position !== undefined ? { position: bundle.meta.position } : {}),
    ...(bundle.manifest.book.progressFraction !== undefined
      ? { progressFraction: bundle.manifest.book.progressFraction }
      : {}),
    ...(bundle.meta.processing !== undefined ? { processing: bundle.meta.processing } : {}),
  }
  await putBook(book)

  const chapters = bundle.chapters.map((ct) =>
    chapterTextToChapter(ct, { bookId, chapterId: newChapterId() }),
  )
  await putChapters(chapters)

  const voice = voiceId(bundle.manifest.book.voiceId)
  const mime = audioCodecMime(bundle.manifest.audio.codec)
  const now = Date.now()
  let audioWritten = 0
  for (const [key, bytes] of bundle.audio) {
    // Content-addressed dedup: if this paragraph is already cached under the
    // same voice, skip the write entirely. The key namespaces by voice +
    // NORM_VERSION + sha256(normalized text), so a hit means byte-identical
    // input — no reason to overwrite (and doing so would needlessly churn the
    // existing entry's bookId ownership).
    const existing = await getAudioCacheEntry(key)
    if (existing !== undefined) continue
    await putAudioCacheEntry({
      key,
      blob: new Blob([bytes as BlobPart], { type: mime }),
      bookId,
      sizeBytes: bytes.length,
      synthMs: 0,
      durationSeconds: 0,
      voiceId: voice,
      lastUsed: now,
      createdAt: now,
    })
    audioWritten++
  }

  if (bundle.meta.source !== undefined) {
    await putBookFile({
      bookId,
      // The raw file is intentionally NOT embedded in the bundle (size + DRM
      // concerns); provenance carries the filename + format only. An empty
      // blob is the honest representation — re-parse from this file is not
      // possible, but playback + re-synth are unaffected.
      blob: new Blob([], { type: sourceFormatMime(bundle.meta.source.format) }),
      name: bundle.meta.source.filename,
      type: sourceFormatMime(bundle.meta.source.format),
      size: 0,
    })
  }

  return { bookId, imported: { chapters: chapters.length, audio: audioWritten } }
}
