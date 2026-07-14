/**
 * Static registry of known OpenAI-compatible cloud providers.
 *
 * Each preset pre-fills `baseUrl`, provides a signup link, and declares whether
 * the provider's `/models` endpoint is usable from the browser (CORS-safe +
 * public). Users can always pick "Custom" for any OpenAI-compatible endpoint
 * not listed here.
 *
 * CORS was verified manually for each provider (see M6 research). Browser-direct
 * fetch is the only path — TaleTrek has no backend proxy (VISION.md non-goal).
 */

export interface ProviderPreset {
  /** Stable identifier matching `CloudProvider.presetId`. */
  id: string
  /** Human-readable name for the preset card / dropdown. */
  label: string
  /** The OpenAI-compatible base URL (no trailing slash). */
  baseUrl: string
  /** One-line description for the preset picker. */
  description: string
  /** URL where the user can sign up / create an API key. */
  signupUrl: string
  /** Provider-specific guidance on key scoping / spend caps. */
  keyScopeHint: string
  /** Whether `GET {baseUrl}/models` is CORS-safe and public (no auth needed). */
  supportsModelsEndpoint: boolean
  /** Whether browser-direct fetch works (CORS headers present). */
  corsSafe: boolean
  /** Sensible default model if discovery fails or is skipped. */
  defaultModel?: string
  /**
   * Static, curated model list. When set, the model picker renders a dropdown
   * from this list WITHOUT calling `/models` — used by providers whose
   * discovery endpoint is unreliable from the browser (CORS/auth) or whose
   * usable models are a small known set. Takes precedence over
   * {@link ProviderPreset.supportsModelsEndpoint}. Users can still type any
   * id manually via the "Type manually" toggle.
   */
  models?: readonly PresetModel[]
}

/** A fixed model entry for a {@link ProviderPreset.models} static list. */
export interface PresetModel {
  /** The model id to send in `chat/completions` body. */
  id: string
  /** Optional display name; falls back to {@link PresetModel.id}. */
  name?: string
  /** Whether the model is free to use. */
  free?: boolean
}

const CUSTOM_PRESET: ProviderPreset = {
  id: 'custom',
  label: 'Custom',
  baseUrl: '',
  description: 'Any OpenAI-compatible endpoint',
  signupUrl: '',
  keyScopeHint: 'Ensure the endpoint is OpenAI-compatible (POST /chat/completions).',
  supportsModelsEndpoint: false,
  corsSafe: false,
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    description: '200+ models from many providers, 26+ free',
    signupUrl: 'https://openrouter.ai/keys',
    keyScopeHint: 'Use a key with a monthly spend cap.',
    supportsModelsEndpoint: true,
    corsSafe: true,
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    description: 'Ultra-fast inference, free tier available',
    signupUrl: 'https://console.groq.com/keys',
    keyScopeHint: 'Free tier is rate-limited; no spend cap needed.',
    supportsModelsEndpoint: true,
    corsSafe: true,
    defaultModel: 'llama-3.1-8b-instant',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    description: 'GPT-4o, GPT-4o-mini, o-series',
    signupUrl: 'https://platform.openai.com/api-keys',
    keyScopeHint: 'Use a Project-scoped key with a $5–10 monthly limit.',
    supportsModelsEndpoint: true,
    corsSafe: true,
    defaultModel: 'gpt-4o-mini',
  },
  {
    id: 'together',
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    description: 'Open-source models, competitive pricing',
    signupUrl: 'https://api.together.xyz/settings/api-keys',
    keyScopeHint: 'Use a key with a spend cap.',
    supportsModelsEndpoint: true,
    corsSafe: true,
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  },
  {
    id: 'zen',
    label: 'OpenCode Zen',
    baseUrl: 'https://opencode.ai/zen/v1',
    description: 'Curated gateway — free models, no card needed',
    signupUrl: 'https://opencode.ai/auth',
    keyScopeHint:
      'Pay-as-you-go; add credits at opencode.ai/auth. The free models below ' +
      'are the only ones that route to the OpenAI-compatible /chat/completions ' +
      'endpoint TaleTrek calls. Free models may use submitted text for training ' +
      '— avoid sensitive books.',
    // Zen's /models endpoint returns the full catalogue (Claude/GPT/Gemini on
    // /messages, /responses, etc.) and is unreliable from the browser. Instead,
    // surface a curated static dropdown of the free /chat/completions models.
    supportsModelsEndpoint: false,
    corsSafe: true,
    defaultModel: 'deepseek-v4-flash-free',
    models: [
      { id: 'big-pickle', free: true },
      { id: 'deepseek-v4-flash-free', free: true },
      { id: 'hy3-free', free: true },
      { id: 'mimo-v2.5-free', free: true },
      { id: 'nemotron-3-ultra-free', free: true },
      { id: 'north-mini-code-free', free: true },
    ],
  },
  CUSTOM_PRESET,
]

/** Look up a preset by id. Returns the Custom preset as fallback. */
export function getPreset(id: string): ProviderPreset {
  return PROVIDER_PRESETS.find((p) => p.id === id) ?? CUSTOM_PRESET
}

/** Find a preset whose `baseUrl` matches (for inferring preset from a provider). */
export function findPresetByBaseUrl(baseUrl: string): ProviderPreset | undefined {
  const normalized = baseUrl.replace(/\/+$/, '')
  return PROVIDER_PRESETS.find((p) => p.baseUrl && p.baseUrl.replace(/\/+$/, '') === normalized)
}
