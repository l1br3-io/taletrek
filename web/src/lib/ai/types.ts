/**
 * M6.2 AI-transform domain types — definition-driven (v2).
 *
 * Transforms are user-defined {@link TransformDefinition} objects (created in
 * Settings → AI → Transform options, optionally seeded from a template gallery).
 * Each book's {@link AppliedProcessing} records the ordered list of def-ids
 * + runtime params that were last applied.
 *
 * The cloud API key lives in `keyring.ts` (in-memory only,
 * `docs/adr/0004-api-key-threat-model.md`).
 */

// ---------------------------------------------------------------------------
// Stable identifiers
// ---------------------------------------------------------------------------

export type TransformDefId = string & { readonly __brand: 'TransformDefId' }

export function transformDefId(value: string): TransformDefId {
  return value as TransformDefId
}

export function newTransformDefId(): TransformDefId {
  return transformDefId(crypto.randomUUID())
}

// ---------------------------------------------------------------------------
// Transform definitions (user-authored, stored in settings)
// ---------------------------------------------------------------------------

/**
 * A single user-facing parameter that feeds a `{{key}}` slot in the definition's
 * system-prompt template. The CRUD UI renders the appropriate input (text field,
 * range slider, or dropdown) based on `type`.
 */
export interface ParamSpec {
  /** Variable name referenced as `{{key}}` in the system-prompt template. */
  key: string
  type: 'text' | 'range' | 'select'
  label: string
  default: string | number
  /** Range-only: minimum value (inclusive). */
  min?: number
  /** Range-only: maximum value (inclusive). */
  max?: number
  /** Range-only: slider step. */
  step?: number
  /** Select-only: dropdown options. */
  options?: { label: string; value: string }[]
}

/**
 * A user-defined (or template-seeded) transform. Every transform carries its
 * own system prompt (markdown with `{{var}}` interpolation) and parameter spec.
 *
 * The optional `providerId` / `model` override the global active provider when
 * set — e.g. a "Translate" def pinned to a high-quality model while other defs
 * use the cheaper default.
 */
export interface TransformDefinition {
  id: TransformDefId
  /** Short label for lists and buttons (e.g. "Clean up OCR"). */
  label: string
  /** One-line hint for checkbox/selector captions. */
  hint: string
  /** Longer description shown in the transform picker. */
  desc: string
  /** Markdown system-prompt template. `{{key}}` slots are interpolated from runtime params. */
  systemPrompt: string
  params: ParamSpec[]
  /** Per-def provider override (falls back to global `activeProviderId`). */
  providerId?: string
  /** Per-def model override (falls back to the provider's configured model). */
  model?: string
}

// ---------------------------------------------------------------------------
// Template gallery (seeds for the CRUD "New transform" flow)
// ---------------------------------------------------------------------------

/** Template presets available when creating a new transform from scratch. */
export interface TransformTemplate {
  label: string
  hint: string
  desc: string
  systemPrompt: string
  params: ParamSpec[]
}

// ---------------------------------------------------------------------------
// Runtime transform op
// ---------------------------------------------------------------------------

/** A single transform scheduled for a run — references a definition + supplies runtime param values. */
export interface TransformOp {
  defId: TransformDefId
  params: Record<string, string | number>
}

// ---------------------------------------------------------------------------
// Pronunciation
// ---------------------------------------------------------------------------

/** Category hint the LLM attaches to a pronunciation candidate. */
export type PronunciationCategory = 'proper-noun' | 'foreign' | 'neologism' | 'other'

/** A chapter boundary detected by AI outline detection. */
export interface AiOutlineChapter {
  /** Paragraph index in the original flat text where this chapter starts. */
  paragraphIndex: number
  title: string
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

// ---------------------------------------------------------------------------
// Engine contract
// ---------------------------------------------------------------------------

/** Contract the cloud backend implements. */
export interface AiTransformEngine {
  /** True when the backend can serve a request now (key set). */
  isReady(): Promise<boolean>
  /**
   * Transform `input` paragraphs per `def` with `op.params`. Returns one output
   * string per input paragraph (solo/windowed-10-1 preserve count;
   * windowed-10-0 may reduce — callers handle the difference). Reports progress
   * 0..1 per chunk.
   *
   * Abort: honours `signal` directly (AbortController on `fetch`).
   */
  transform(
    input: string[],
    op: TransformOp,
    def: TransformDefinition,
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

// ---------------------------------------------------------------------------
// Per-book processing record
// ---------------------------------------------------------------------------

/** Per-book record of the last applied processing. Additive on `Book`. */
export interface AppliedProcessing {
  appliedAt: number
  /** Ordered list of transform def-ids + their runtime params. */
  ops: TransformOp[]
}

// ---------------------------------------------------------------------------
// Cloud provider
// ---------------------------------------------------------------------------

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
  /** Model context window size in tokens (auto-filled from preset, user-editable). */
  contextLimit?: number
}

// ---------------------------------------------------------------------------
// AI settings (additive on global Settings)
// ---------------------------------------------------------------------------

/** Additive `ai?` field on {@link Settings}. Key is NOT here (ADR-0004). */
export interface AiSettings {
  enabled: boolean
  /** Discriminator retained for settings migration; always `'cloud'` now. */
  backend: 'cloud'
  cloud: {
    providers: CloudProvider[]
    /** Which provider in `providers` is active, or `null` if none configured. */
    activeProviderId: string | null
    /**
     * Opt-in biometric key caching (ADR-0007). When `true`, the app attempts
     * `secure-keyring.unlock()` on hydrate — one biometric tap restores the
     * cached keys. Default `false`; the in-memory tier (ADR-0004) remains the
     * fallback when the flag is off, when PRF is unsupported, or when the user
     * cancels the biometric prompt.
     */
    biometricUnlock?: boolean
  }
  /** User-authored transform definitions (M6.2). Starts empty. */
  transformDefs: TransformDefinition[]
}
