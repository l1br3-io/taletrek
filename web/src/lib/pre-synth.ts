import type { BookId, Chapter, VoiceId } from '../types'
import type { SynthesisResult, TtsEngine } from './tts/types'

export interface PreSynthOptions {
  bookId: BookId
  chapters: Chapter[]
  voiceId: VoiceId
  engine: TtsEngine
  onProgress?: (
    done: number,
    total: number,
    completed?: ParagraphLocation,
    info?: { synthMs: number; durationSeconds: number },
  ) => void
  onVoiceDownload?: (fraction: number) => void
  /**
   * Fired before each paragraph's synth attempt. Carries the book-relative
   * location and a short text preview so the caller can (a) surface "currently
   * synthesizing ¶ X/Y in chapter Z" in the UI, and (b) persist the location
   * onto the book record — surviving tab eviction, where vConsole state is
   * lost. The text preview is bounded to 60 chars.
   *
   * With `concurrency > 1`, fires in dispatch order (flat order) for every
   * dispatched paragraph — including ones that may already be in flight. Use
   * `onProgress`'s `completed` arg for the *completed* paragraph's location.
   */
  onParagraphStart?: (info: {
    flatIndex: number
    flatTotal: number
    location: ParagraphLocation
    textPreview: string
  }) => void
  /** Abort the run cooperatively — checked before each new dispatch. */
  signal?: AbortSignal
  /**
   * Max paragraphs synthesized in parallel (ADR-0011 / parallel synthesis).
   * Default `1` = today's sequential behavior. Set to `>1` (typically
   * `PoolEngine.concurrency`) to overlap cold model loads and pipeline cache
   * hits with slow predicts. In-flight synths are NOT cancelled on abort —
   * their results land in the cache and a resume fast-forwards through them.
   */
  concurrency?: number
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
 * Pre-synthesize every paragraph in a book, storing results in the audio cache.
 * Cache hits are free (no Piper inference).
 *
 * Returns per-paragraph cache keys and durations for downstream concat+encode
 * (mobile Path A) or streaming (future M9.1). The `paragraphs` array is
 * indexed by flat position — `paragraphs[i]` is always paragraph `i`'s cache
 * key, regardless of completion order under `concurrency > 1`.
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
 *
 * Concurrency: when `concurrency > 1` (ADR-0011 / parallel synthesis), up to
 * that many paragraphs are synth'd in parallel against a worker pool.
 * In-flight synths are not cancelled on abort — their results land in the
 * cache and resume fast-forwards through them. The first-fail-hard contract
 * is preserved: any rejection tears down the run immediately, abandoning the
 * remaining in-flight results to the cache.
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
    concurrency: concurrencyRaw,
  } = opts
  const concurrency = Math.max(1, concurrencyRaw ?? 1)

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
  console.log('[taletrek] pre-synth: start', { bookId, voiceId, total, voiceStored, concurrency })

  if (!voiceStored) {
    console.log('[taletrek] pre-synth: downloading voice', { voiceId })
    await engine.download(voiceId, onVoiceDownload)
    console.log('[taletrek] pre-synth: voice download done', { voiceId })
  }

  let done = 0
  let synthesized = 0
  let cached = 0
  // Indexed by flat position — `info[i]` is paragraph i's cache info,
  // regardless of completion order. Holes remain only on a cancelled run;
  // downstream (concat) isn't reached in that case.
  const info: ParagraphPreSynthInfo[] = new Array(total)

  /** Dispatch the paragraph at `flatIndex`, fire onParagraphStart, return the result. */
  const dispatchOne = (flatIndex: number): Promise<SynthesisResult> => {
    const para = flat[flatIndex]
    if (!para) {
      // Should be impossible — flatIndex only comes from `nextDispatch` which
      // is bounded by `flat.length`. Defensive throw keeps TS happy without a
      // non-null assertion.
      throw new Error(`pre-synth: flat index out of range (${flatIndex}/${total})`)
    }
    const chapterTotal = chapterTotals[para.chapterIndex] ?? 0
    const textPreview = para.text.slice(0, 60)
    console.log('[taletrek] pre-synth: synth start', {
      index: flatIndex,
      total,
      concurrency,
      chapterIndex: para.chapterIndex,
      paragraphInChapter: para.paragraphInChapter,
      chapterTotal,
      textLen: para.text.length,
      textPreview,
    })
    onParagraphStart?.({
      flatIndex,
      flatTotal: total,
      location: {
        chapterIndex: para.chapterIndex,
        chapterTitle: para.chapterTitle,
        paragraphInChapter: para.paragraphInChapter,
        chapterTotal,
      },
      textPreview,
    })
    return synthesizeWithTimeout(
      engine,
      { text: para.text, voiceId, bookId, returnAudio: false },
      signal,
    )
  }

  // Bounded-concurrency dispatch window. With concurrency=1 this is exactly
  // the previous sequential behaviour: dispatch one, await it, dispatch the
  // next. With concurrency>1, the window fills up to that many in-flight
  // synths; completion of any one frees a slot for the next dispatch.
  let nextDispatch = 0
  const inflight: Array<{ flatIndex: number; promise: Promise<SynthesisResult> }> = []

  while (nextDispatch < total || inflight.length > 0) {
    // Fill the window up to `concurrency`, honouring the abort signal — no
    // new dispatches once aborted, but in-flight synths drain to completion
    // (their cache entries are useful for resume).
    while (!signal?.aborted && inflight.length < concurrency && nextDispatch < total) {
      const flatIndex = nextDispatch++
      inflight.push({ flatIndex, promise: dispatchOne(flatIndex) })
    }
    if (inflight.length === 0) break // signal aborted + nothing in-flight

    // Wait for any one in-flight synth to settle, then process it.
    const settled = await Promise.race(
      inflight.map(async (entry) => {
        try {
          const r = await entry.promise
          return { entry, ok: true as const, r }
        } catch (e) {
          return { entry, ok: false as const, e }
        }
      }),
    )
    // Remove the settled entry from the window.
    const removeIdx = inflight.indexOf(settled.entry)
    if (removeIdx >= 0) inflight.splice(removeIdx, 1)

    if (!settled.ok) {
      const err = settled.e
      const para = flat[settled.entry.flatIndex]
      if (!para) {
        throw new Error(`pre-synth: flat index out of range (${settled.entry.flatIndex}/${total})`)
      }
      const chapterTotal = chapterTotals[para.chapterIndex] ?? 0
      const textPreview = para.text.slice(0, 60)
      console.error('[taletrek] pre-synth: synth failed', {
        index: settled.entry.flatIndex,
        total,
        concurrency,
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
        flatIndex: settled.entry.flatIndex,
        flatTotal: total,
        text: para.text,
        cause: err,
      })
    }

    const para = flat[settled.entry.flatIndex]
    if (!para) {
      throw new Error(`pre-synth: flat index out of range (${settled.entry.flatIndex}/${total})`)
    }
    const chapterTotal = chapterTotals[para.chapterIndex] ?? 0
    const location: ParagraphLocation = {
      chapterIndex: para.chapterIndex,
      chapterTitle: para.chapterTitle,
      paragraphInChapter: para.paragraphInChapter,
      chapterTotal,
    }
    console.log('[taletrek] pre-synth: synth done', {
      index: settled.entry.flatIndex,
      total,
      synthMs: settled.r.synthMs,
      cached: settled.r.synthMs === 0,
    })
    info[settled.entry.flatIndex] = {
      cacheKey: settled.r.cacheKey,
      durationSeconds: settled.r.durationSeconds,
    }
    if (settled.r.synthMs === 0) cached++
    else synthesized++
    done++
    onProgress?.(done, total, location, {
      synthMs: settled.r.synthMs,
      durationSeconds: settled.r.durationSeconds,
    })
  }

  const cancelled = signal?.aborted === true
  if (cancelled) {
    console.log('[taletrek] pre-synth: aborted', { done, total })
  } else {
    console.log('[taletrek] pre-synth: done', { total, synthesized, cached })
  }
  // On cancel, compact `info` (downstream isn't reached, but the type says
  // `ParagraphPreSynthInfo[]` and holes would be surprising to inspect).
  const compacted = cancelled ? info.filter((p) => p !== undefined) : info
  return { total, synthesized, cached, cancelled, paragraphs: compacted }
}
