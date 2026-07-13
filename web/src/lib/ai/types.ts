/**
 * M6 AI-transform domain types.
 *
 * A cloud (OpenAI-compatible) backend implements the
 * {@link AiTransformEngine} contract. See `docs/prds/M6-ai-transforms.md` and
 * `docs/adr/0003-ai-transform-architecture.md`.
 *
 * The cloud API key is deliberately NOT modelled here — it lives in
 * `keyring.ts` (in-memory only, per `docs/adr/0004-api-key-threat-model.md`).
 */

/** Kinds of AI paragraph-transformation TaleTrek supports (v1 scope). */
export type TransformKind = 'cleanup' | 'translate' | 'summarize' | 'simplify'

/** Category hint the LLM attaches to a pronunciation candidate. */
export type PronunciationCategory = 'proper-noun' | 'foreign' | 'neologism' | 'other'

/** A chapter boundary detected by AI outline detection. */
export interface AiOutlineChapter {
  /** Paragraph index in the original flat text where this chapter starts. */
  paragraphIndex: number
  title: string
}

/** Parameterized op passed to {@link AiTransformEngine.transform}. */
export type TransformOp =
  | { kind: 'cleanup' }
  | { kind: 'translate'; target: string }
  | { kind: 'summarize'; ratio: number }
  | { kind: 'simplify'; level: number }

/** Per-op parameters recorded on a book after a transform run. */
export interface TransformParams {
  translate?: { target: string }
  summarize?: { ratio: number }
  simplify?: { level: number }
}

/**
 * LLM-proposed pronunciation candidate — pre-review. After the user accepts,
 * it collapses to the existing global {@link PronunciationEntry} (dropping
 * `confidence` + `category`, which are authoring-time metadata only).
 */
export interface PronunciationCandidate {
  id: string
  find: string
  replace: string
  /** 0..1 — drives ranking + bulk auto-accept threshold. */
  confidence: number
  category: PronunciationCategory
}

/** Contract the cloud backend implements. */
export interface AiTransformEngine {
  /** True when the backend can serve a request now (key set). */
  isReady(): Promise<boolean>
  /**
   * Transform `input` paragraphs per `op`. Returns one output string per input
   * paragraph (cleanup/translate/simplify preserve count; summarize may reduce —
   * callers handle the difference). Reports progress 0..1 per chunk.
   *
   * Abort: honours `signal` directly (AbortController on `fetch`).
   */
  transform(
    input: string[],
    op: TransformOp,
    onProgress?: (fraction: number) => void,
    signal?: AbortSignal,
  ): Promise<string[]>
  /**
   * Scan a sample (first chapter) for pronunciation candidates. Does not mutate
   * `paragraphs` — accepted entries land in the global dictionary at TTS time.
   */
  proposePronunciationHints(
    sample: string[],
    onProgress?: (fraction: number) => void,
    signal?: AbortSignal,
  ): Promise<PronunciationCandidate[]>
  /**
   * Scan the book's flat paragraph list for chapter headings using the LLM.
   * Returns one entry per detected chapter boundary (paragraph index + title).
   * Callers split the paragraphs at those indices, mirroring `detectOutline`.
   */
  detectOutline(
    paragraphs: string[],
    onProgress?: (fraction: number) => void,
    signal?: AbortSignal,
  ): Promise<AiOutlineChapter[]>
}

/** Per-book record of the last applied processing. Additive on `Book`. */
export interface AppliedProcessing {
  appliedAt: number
  transforms: TransformKind[]
  params: TransformParams
}

/**
 * A configured cloud provider. Multiple can coexist; the user switches
 * between them by setting {@link AiSettings.cloud.activeProviderId}.
 * The API key for each provider lives in-memory only (`keyring.ts`),
 * keyed by `provider.id` — never persisted (ADR-0004).
 */
export interface CloudProvider {
  /** Stable unique id (crypto.randomUUID). */
  id: string
  /** Preset id from `providers.ts`, or `'custom'`. */
  presetId: string
  baseUrl: string
  model: string
  /** Optional user-customizable display label. */
  label?: string
}

/** Additive `ai?` field on {@link Settings}. Key is NOT here (ADR-0004). */
export interface AiSettings {
  enabled: boolean
  /** Discriminator retained for settings migration; always `'cloud'` now. */
  backend: 'cloud'
  cloud: {
    providers: CloudProvider[]
    /** Which provider in `providers` is active, or `null` if none configured. */
    activeProviderId: string | null
  }
}
