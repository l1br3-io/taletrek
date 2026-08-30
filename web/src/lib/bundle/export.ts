/**
 * IDB egress seam for `.taletrek` book bundles. The inverse of
 * {@link importBookBundle}: reads a library book out of IndexedDB and produces
 * a {@link BookBundle} ready for {@link writeBookBundle} to serialize.
 *
 * The non-obvious work is **voice recovery**. The SPA's `Book` type carries no
 * `voiceId` — audio is content-addressed under a voice, but the book record
 * itself doesn't pin one. The voice survives denormalized on each
 * `AudioCacheRecord.voiceId` (and transiently on a paused `PersistedUploadJob`).
 * Export recovers it from a cached audio record for the book; when none exists,
 * full export is refused (resolved decision #2) and text-only export falls back
 * to the user's current default voice from settings so the desktop can still
 * synth it.
 */

import pkg from '../../../package.json'
import type { BookId, VoiceId } from '../../types'
import { audioCacheKey } from '../audio-cache'
import {
  getAudioCacheEntry,
  getAudioCacheKeysByBook,
  getBook,
  getBookFile,
  getChaptersByBook,
  getSetting,
} from '../db'
import { NORM_VERSION } from '../tts/normalize'
import { DEFAULT_VOICE_ID } from '../tts/voices'
import { NoAudioToExportError } from './errors'
import {
  type BookBundle,
  type BookMeta,
  chapterToChapterText,
  MANIFEST_SCHEMA_VERSION,
  SPA_GENERATOR_APP,
  WRITABLE_AUDIO_CODEC,
} from './manifest'

/** IDB key the {@link SettingsProvider} stores the merged settings under. */
const SETTINGS_KEY = 'app'

/**
 * Read the user's current default voice from settings (stored as one object
 * under the `'app'` key — mirrors `upload/manager.ts`'s settings read). Falls
 * back to {@link DEFAULT_VOICE_ID} when settings haven't been written yet.
 */
async function getDefaultVoiceId(): Promise<VoiceId> {
  const stored = await getSetting<{ voiceId?: VoiceId }>(SETTINGS_KEY)
  return stored?.voiceId ?? DEFAULT_VOICE_ID
}

/**
 * Recover the voice a book was synthesized under, without reading it off the
 * `Book` record (which has no voice field — see module doc). Tries cached audio
 * first (the persistent source of truth), then the supplied fallback (a paused
 * `uploadJob.voiceId`). Returns `undefined` when neither source has a voice —
 * full export refuses on that.
 */
async function recoverVoice(
  ownedKeys: ReadonlySet<string>,
  fallbackVoice?: VoiceId,
): Promise<VoiceId | undefined> {
  for (const firstKey of ownedKeys) {
    return (await getAudioCacheEntry(firstKey))?.voiceId
  }
  return fallbackVoice
}

/**
 * Export a library book as a {@link BookBundle} ready for {@link writeBookBundle}.
 *
 * - `full: true` — collects every distinct non-empty paragraph across the
 *   book's chapters, recovers the voice from a cached audio record, and loads
 *   each paragraph's synthesized bytes into the audio map. Throws
 *   {@link NoAudioToExportError} when no audio is recoverable.
 * - `full: false` — text-only: writes `manifest.book.voiceId` from the
 *   recovered voice if available, else the user's current default voice.
 *
 * Populates `meta/{position,processing,source}` from `Book` fields + the
 * `files` store. Stamps nothing the writer owns (generator, codec, final
 * `audio.present`/`segmentCount`) — those are derived by the writer.
 */
export async function exportBookBundle(
  bookId: BookId,
  opts: { full: boolean },
): Promise<BookBundle> {
  const book = await getBook(bookId)
  if (!book) throw new Error(`Cannot export: book ${bookId} not found in the library`)

  const chapters = await getChaptersByBook(bookId)
  const ownedKeys = new Set(await getAudioCacheKeysByBook(bookId))
  const recoveredVoice = await recoverVoice(ownedKeys)

  const audio = new Map<string, Uint8Array>()
  let voice: VoiceId

  if (opts.full) {
    if (recoveredVoice === undefined) throw new NoAudioToExportError()
    voice = recoveredVoice
    for (const ch of chapters) {
      for (const text of ch.paragraphs) {
        if (!text.trim()) continue
        const key = await audioCacheKey(voice, text)
        if (!ownedKeys.has(key) || audio.has(key)) continue
        const record = await getAudioCacheEntry(key)
        if (!record) continue
        audio.set(key, new Uint8Array(await record.blob.arrayBuffer()))
      }
    }
    if (audio.size === 0) throw new NoAudioToExportError()
  } else {
    voice = recoveredVoice ?? (await getDefaultVoiceId())
  }

  const meta: BookBundle['meta'] = {}
  if (book.position !== undefined) {
    meta.position = {
      chapterIndex: book.position.chapterIndex,
      paragraphIndex: book.position.paragraphIndex,
    }
  }
  if (book.processing !== undefined) {
    meta.processing = book.processing
  }
  const file = await getBookFile(bookId)
  if (file !== undefined) {
    meta.source = { filename: file.name, format: book.format }
  }

  const bookMeta: BookMeta = {
    id: book.id,
    title: book.title,
    sourceFormat: book.format,
    chapterCount: book.chapterCount,
    voiceId: voice,
    createdAt: book.createdAt,
    updatedAt: book.updatedAt,
    ...(book.progressFraction !== undefined ? { progressFraction: book.progressFraction } : {}),
  }

  return {
    manifest: {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      kind: 'book',
      book: bookMeta,
      audio: {
        present: audio.size > 0,
        codec: WRITABLE_AUDIO_CODEC,
        normVersion: Number(NORM_VERSION),
        segmentCount: audio.size,
      },
      generator: { app: SPA_GENERATOR_APP, version: pkg.version },
    },
    chapters: chapters.map(chapterToChapterText),
    audio,
    meta,
  }
}
