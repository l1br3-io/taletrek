/**
 * Connection test — fires a minimal chat completion to validate that the
 * provider, key, and model are all working together.
 *
 * No other BYOK tool does this (research finding). It eliminates the
 * "discover a typo mid-transform" problem: the user gets immediate feedback
 * when configuring a provider, not 20 paragraphs into a book transform.
 *
 * The request is non-streaming with `max_tokens: 1` to minimise cost.
 */

export type ConnectionTestResult =
  | { type: 'success' }
  | { type: 'auth-error' }
  | { type: 'model-not-found' }
  | { type: 'network' }
  | { type: 'error'; status: number; message: string }

/**
 * Send a minimal `POST {baseUrl}/chat/completions` request and classify the
 * result.
 *
 * @param baseUrl  Provider base URL
 * @param apiKey   API key to test
 * @param model    Model id to test
 * @param signal   Optional abort signal
 */
export async function testConnection(
  baseUrl: string,
  apiKey: string,
  model: string,
  signal?: AbortSignal,
): Promise<ConnectionTestResult> {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`
  const body = {
    model,
    messages: [{ role: 'user', content: '.' }],
    max_tokens: 1,
    stream: false,
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    })

    if (res.ok) return { type: 'success' }

    if (res.status === 401 || res.status === 403) return { type: 'auth-error' }
    if (res.status === 404) return { type: 'model-not-found' }

    const text = await res.text().catch(() => '')
    return {
      type: 'error',
      status: res.status,
      message: `${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ''}`,
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err
    }
    // A `fetch` TypeError is indistinguishable between a genuine CORS block,
    // a network failure, and a server error response (e.g. 429/5xx) whose body
    // the browser hid because it lacked `Access-Control-Allow-Origin`. The last
    // case is common with rate-limited responses served by CDNs — the real
    // status is visible only in DevTools → Network, never to JS. We therefore
    // return `network` (not `cors`) so callers can give honest guidance.
    return { type: 'network' }
  }
}
