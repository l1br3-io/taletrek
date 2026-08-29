/**
 * Boot-time mode resolution (ADR-0014, Effort 5 · T13).
 *
 * Mode-probe contract — decided once, before React mounts:
 * - `GET /api/session`, same-origin, cookies implicit, `cache: 'no-store'`.
 * - `200` → a reachable, authed personal server hosts this origin → **server
 *   mode** (`ServerDatasource`, same-origin HTTP).
 * - `401` → the server is there but the session cookie is missing/expired →
 *   redirect to `/ui/login` (the no-JS cookie gate). Local mode is returned so
 *   the app still renders if the navigation is somehow blocked; the login flow
 *   bounces back to `/` and the probe re-runs authed.
 * - Anything else — `404`, `5xx`, a fetch rejection (unreachable origin, dev
 *   proxy down) — → **local mode, silently**. This is the invariant that keeps
 *   the standalone PWA byte-identical: on a static host `/api/session` 404s,
 *   and in dev with no server running the Vite proxy errors. One refinement
 *   (T17): a fetch rejection on an origin that previously resolved **server**
 *   (localStorage marker, see {@link HOSTED_SHAPE_KEY}) stays **server** — an
 *   offline reload of the hosted shape must surface its offline state, not
 *   masquerade as an empty standalone library.
 *
 * The probe runs exactly once per boot (`main.tsx`); the mode never switches
 * mid-session. `fetchImpl` is injectable for tests only.
 */

export type DatasourceMode = 'local' | 'server'

export interface ResolvedDatasource {
  mode: DatasourceMode
}

/**
 * LocalStorage marker remembering that this origin has hosted the server
 * shape (T17). A fetch-rejected probe is ambiguous — static origin vs a
 * server origin that is currently offline — so the last definitive answer
 * breaks the tie: unreachable + marker → server mode, and the library shows
 * its explicit offline state instead of silently swapping to an empty local
 * library. Never set on standalone origins; cleared only by a definitive
 * 404 (the origin stopped being a server), untouched on 5xx (broken server
 * ≠ static origin). Script-storage eviction (G2) degrades to the
 * marker-less behavior — never worse than before the marker existed.
 */
const HOSTED_SHAPE_KEY = 'taletrek:hosted-shape'

function rememberHostedShape(hosted: boolean): void {
  try {
    if (hosted) window.localStorage.setItem(HOSTED_SHAPE_KEY, '1')
    else window.localStorage.removeItem(HOSTED_SHAPE_KEY)
  } catch {
    // Private browsing / quota — the marker is an optimization, not a
    // requirement; resolution degrades to the marker-less behavior.
  }
}

function hasSeenHostedShape(): boolean {
  try {
    return window.localStorage.getItem(HOSTED_SHAPE_KEY) === '1'
  } catch {
    return false
  }
}

export async function resolveDatasourceMode(
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedDatasource> {
  try {
    const res = await fetchImpl('/api/session', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
    })
    if (res.status === 200) {
      rememberHostedShape(true)
      return { mode: 'server' }
    }
    if (res.status === 401) {
      rememberHostedShape(true)
      window.location.assign('/ui/login')
      return { mode: 'local' }
    }
    if (res.status === 404) {
      // A reachable origin that 404s the probe is definitively not a
      // server — retire any stale marker from a prior hosted life.
      rememberHostedShape(false)
    }
    return { mode: 'local' }
  } catch {
    return { mode: hasSeenHostedShape() ? 'server' : 'local' }
  }
}
