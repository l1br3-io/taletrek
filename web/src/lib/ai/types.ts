/**
 * M6 AI-transform domain types.
 *
 * Two backends (in-browser WebLLM, cloud OpenAI-compatible) implement one
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

/** Contract both backends implement. */
export interface AiTransformEngine {
  /** True when the backend can serve a request now (model loaded / key set). */
  isReady(): Promise<boolean>
  /**
   * Transform `input` paragraphs per `op`. Returns one output string per input
   * paragraph (cleanup/translate/simplify preserve count; summarize may reduce —
   * callers handle the difference). Reports progress 0..1 per chunk.
   *
   * Abort: cloud honours `signal` directly (AbortController on `fetch`); the
   * in-browser engine bridges `signal.aborted` to WebLLM's `interruptGenerate()`.
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
}

/** Per-book record of the last applied processing. Additive on `Book`. */
export interface AppliedProcessing {
  appliedAt: number
  transforms: TransformKind[]
  params: TransformParams
}

/** Additive `ai?` field on {@link Settings}. Key is NOT here (ADR-0004). */
export interface AiSettings {
  enabled: boolean
  backend: 'in-browser' | 'cloud'
  inBrowser: { modelId: string }
  cloud: { baseUrl: string; model: string }
  modal: { beforeUpload: boolean; afterUpload: boolean }
}
