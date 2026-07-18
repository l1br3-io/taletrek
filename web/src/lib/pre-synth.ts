import type { BookId, Chapter, VoiceId } from '../types'
import type { SynthesisResult, TtsEngine } from './tts/types'

export interface PreSynthOptions {
  bookId: BookId
  chapters: Chapter[]
  voiceId: VoiceId
  engine: TtsEngine
  onProgress?: (done: number, total: number) => void
  onVoiceDownload?: (fraction: number) => void
  /**
   * Fired before each paragraph's synth attempt. Carries the book-relative
   * location and a short text preview so the caller can (a) surface "currently
   * synthesizing ¶ X/Y in chapter Z" in the UI, and (b) persist the location
   * onto the book record — surviving tab eviction, where vConsole state is
   * lost. The text preview is bounded to 60 chars.
   */
  onParagraphStart?: (info: {
    flatIndex: number
    flatTotal: number
    location: ParagraphLocation
    textPreview: string
  }) => void
  /** Abort the run cooperatively — checked between paragraphs. */
  signal?: AbortSignal
}

export interface ParagraphPreSynthInfo {
  /** Content-addressed audioCache key for this paragraph's WAV. */
  cacheKey: string
  /** Audio duration in seconds, parsed from the synthesised WAV. */
  durationSeconds: number
}

export interface PreSynthResult {
  total: number
  synthesized: number
  cached: number
  cancelled: boolean
  /** Per-paragraph cache keys and durations, in flatten order. */
  paragraphs: ParagraphPreSynthInfo[]
}

/**
 * Where in the book a synth failure happened. Carried on {@link PreSynthError}
 * so the upload UI can tell the user *exactly* which paragraph failed — a
 * bare "synth timed out" message gives the user no way to know whether it
 * was paragraph 3 or paragraph 3003 that broke.
 */
export interface ParagraphLocation {
  /** 0-based chapter index into `chapters`. */
  chapterIndex: number
  chapterTitle: string
  /** 1-based index of the failing paragraph within its chapter (non-empty paragraphs only). */
  paragraphInChapter: number
  /** Count of non-empty paragraphs in the chapter containing the failure. */
  chapterTotal: number
}

/**
 * Error thrown when a per-paragraph synth fails inside {@link preSynthesizeBook}.
 * Wraps the underlying engine error (a `PiperError`, `DOMException` timeout,
 * etc.) and annotates it with the book-relative location.
 *
 * The `message` is formatted for direct display: it identifies chapter +
 * paragraph + overall position, then quotes the cause. The structured fields
 * are present so the upload UI / tests can switch on them without parsing
 * the string.
 */
export class PreSynthError extends Error {
  readonly flatIndex: number
  readonly flatTotal: number
  readonly location: ParagraphLocation
  readonly textPreview: string
  override readonly cause: unknown

  constructor(args: {
    location: ParagraphLocation
    flatIndex: number
    flatTotal: number
    text: string
    cause: unknown
  }) {
    const c = args.cause instanceof Error ? args.cause : undefined
    const phase = (c as { phase?: string } | undefined)?.phase
    const causeMsg = c?.message ?? String(args.cause)
    const title = args.location.chapterTitle.slice(0, 60)
    const chapterPart = `chapter ${args.location.chapterIndex + 1} '${title}'`
    const paraPart = `paragraph ${args.location.paragraphInChapter}/${args.location.chapterTotal}`
    const overallPart = `¶ ${args.flatIndex + 1}/${args.flatTotal} overall`
    const phasePart = phase ? `${phase}: ` : ''
    super(`Synth failed at ${chapterPart}, ${paraPart} (${overallPart}): ${phasePart}${causeMsg}`)
    this.name = 'PreSynthError'
    this.flatIndex = args.flatIndex
    this.flatTotal = args.flatTotal
    this.location = args.location
    this.textPreview = args.text.slice(0, 80)
    this.cause = args.cause
  }
}

/**
 * Per-synth hard timeout (ms). If the worker goes silent (no progress, no
 * response) for this long, we treat the paragraph as failed. iOS Safari can
 * freeze worker execution under memory pressure without firing any event;
 * without this guard the synth loop would hang forever, holding the wake lock
 * and pinning the audio cache. 90s comfortably bounds the worst warm-synth
 * case (~5s for a long paragraph) plus model-load headroom.
 */
const SYNTH_TIMEOUT_MS = 90_000

async function synthesizeWithTimeout(
  engine: TtsEngine,
  req: { text: string; voiceId: VoiceId; bookId: BookId; returnAudio: false },
  signal: AbortSignal | undefined,
): Promise<SynthesisResult> {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new DOMException(
          `synth timed out after ${SYNTH_TIMEOUT_MS / 1000}s — worker may be frozen`,
          'TimeoutError',
        ),
      )
    }, SYNTH_TIMEOUT_MS)
  })
  try {
    return await Promise.race([engine.synthesize(req), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** A non-empty paragraph, annotated with its book-relative location. */
interface FlatParagraph {
  text: string
  chapterIndex: number
  chapterTitle: string
  /** 1-based within the chapter. */
  paragraphInChapter: number
}

/**
 * Pre-synthesize every paragraph in a book sequentially, storing results in
 * the audio cache. Cache hits are free (no Piper inference).
 *
 * Returns per-paragraph cache keys and durations for downstream concat+encode
 * (mobile Path A) or streaming (future M9.1).
 *
 * The caller is responsible for passing **cleaned** chapters — the cache key
 * is derived from the paragraph text, so it must match what the reader will
 * request.
 *
 * Resilience: each synth is bounded by {@link SYNTH_TIMEOUT_MS}; on the first
 * failure the underlying error is wrapped in a {@link PreSynthError} that
 * identifies the chapter + paragraph that broke (so the user can find the
 * offending text) — the M8 content-addressed cache means a retry fast-forwards
 * through anything that succeeded before the abort. Skipping failed
 * paragraphs would desync the concat/Web-Audio consumers, which expect one
 * cache entry per paragraph, so failures remain hard-fail.
 */
export async function preSynthesizeBook(opts: PreSynthOptions): Promise<PreSynthResult> {
  const {
    bookId,
    chapters,
    voiceId,
    engine,
    onProgress,
    onVoiceDownload,
    onParagraphStart,
    signal,
  } = opts

  // Flatten chapters into a located paragraph list. Empty/whitespace-only
  // paragraphs are skipped (matches reader behavior — they're never read).
  // We compute each chapter's non-empty count up front so a failure report
  // can say "paragraph 41 of 312" without re-scanning the chapter at the
  // failure site.
  const flat: FlatParagraph[] = []
  const chapterTotals: number[] = []
  for (const ch of chapters) {
    let n = 0
    for (const p of ch.paragraphs) {
      if (!p.trim()) continue
      n++
      flat.push({
        text: p,
        chapterIndex: ch.index,
        chapterTitle: ch.title,
        paragraphInChapter: n,
      })
    }
    chapterTotals[ch.index] = n
  }
  const total = flat.length

  const voiceStored = await engine.isStored(voiceId)
  console.log('[taletrek] pre-synth: start', { bookId, voiceId, total, voiceStored })

  if (!voiceStored) {
    console.log('[taletrek] pre-synth: downloading voice', { voiceId })
    await engine.download(voiceId, onVoiceDownload)
    console.log('[taletrek] pre-synth: voice download done', { voiceId })
  }

  let done = 0
  let synthesized = 0
  let cached = 0
  const info: ParagraphPreSynthInfo[] = []

  for (const para of flat) {
    if (signal?.aborted) {
      console.log('[taletrek] pre-synth: aborted', { done, total })
      return { total, synthesized, cached, cancelled: true, paragraphs: info }
    }

    // returnAudio: false avoids a main-thread structured-clone of every WAV
    // Blob on memory-constrained devices; the worker computes duration and
    // cache key in-process.
    const chapterTotal = chapterTotals[para.chapterIndex] ?? 0
    const textPreview = para.text.slice(0, 60)
    console.log('[taletrek] pre-synth: synth start', {
      index: done,
      total,
      chapterIndex: para.chapterIndex,
      paragraphInChapter: para.paragraphInChapter,
      chapterTotal,
      textLen: para.text.length,
      textPreview,
    })
    onParagraphStart?.({
      flatIndex: done,
      flatTotal: total,
      location: {
        chapterIndex: para.chapterIndex,
        chapterTitle: para.chapterTitle,
        paragraphInChapter: para.paragraphInChapter,
        chapterTotal,
      },
      textPreview,
    })
    let result: SynthesisResult
    try {
      result = await synthesizeWithTimeout(
        engine,
        { text: para.text, voiceId, bookId, returnAudio: false },
        signal,
      )
    } catch (err) {
      console.error('[taletrek] pre-synth: synth failed', {
        index: done,
        total,
        chapterIndex: para.chapterIndex,
        paragraphInChapter: para.paragraphInChapter,
        chapterTotal,
        textLen: para.text.length,
        textPreview,
        errName: (err as Error).name,
        errPhase: (err as { phase?: string }).phase,
        errCode: (err as DOMException).code,
        errConstructor: (err as object).constructor?.name,
        errMessage: (err as Error).message,
        errStack: (err as Error).stack,
      })
      throw new PreSynthError({
        location: {
          chapterIndex: para.chapterIndex,
          chapterTitle: para.chapterTitle,
          paragraphInChapter: para.paragraphInChapter,
          chapterTotal,
        },
        flatIndex: done,
        flatTotal: total,
        text: para.text,
        cause: err,
      })
    }
    console.log('[taletrek] pre-synth: synth done', {
      index: done,
      total,
      synthMs: result.synthMs,
      cached: result.synthMs === 0,
    })
    if (result.synthMs === 0) cached++
    else synthesized++
    done++
    onProgress?.(done, total)

    info.push({ cacheKey: result.cacheKey, durationSeconds: result.durationSeconds })
  }

  console.log('[taletrek] pre-synth: done', { total, synthesized, cached })
  return { total, synthesized, cached, cancelled: false, paragraphs: info }
}
