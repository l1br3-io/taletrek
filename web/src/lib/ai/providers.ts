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
   * When set, the model picker filters the `/models` list to these ids only.
   * Used by providers (e.g. OpenCode Zen) whose `/models` endpoint returns
   * models that live on incompatible endpoints (Anthropic `/messages`, OpenAI
   * `/responses`) — only the OpenAI-compatible `/chat/completions` ids are
   * listed here. Users can still type any id manually.
   */
  compatibleModelIds?: readonly string[]
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
    description: 'Curated gateway — 40+ verified models',
    signupUrl: 'https://opencode.ai/auth',
    keyScopeHint:
      'Pay-as-you-go; add credits at opencode.ai/auth. Only OpenAI-compatible ' +
      '/chat/completions models work in the browser (shown below). Some free ' +
      'models may use submitted text for training — avoid sensitive books.',
    supportsModelsEndpoint: true,
    corsSafe: true,
    defaultModel: 'glm-5.2',
    // Zen's /models returns ALL models, but only these route to /chat/completions
    // (the endpoint TaleTrek's engine calls). Claude/GPT/Gemini models live on
    // /messages, /responses, /models respectively and would 404 here.
    compatibleModelIds: [
      'glm-5.2',
      'glm-5.1',
      'glm-5',
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'kimi-k2.7-code',
      'kimi-k2.6',
      'kimi-k2.5',
      'minimax-m3',
      'minimax-m2.7',
      'minimax-m2.5',
      'grok-4.5',
      'grok-build-0.1',
      'big-pickle',
      'mimo-v2.5-free',
      'north-mini-code-free',
      'nemotron-3-ultra-free',
      'deepseek-v4-flash-free',
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
