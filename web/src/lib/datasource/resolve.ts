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
 *   and in dev with no server running the Vite proxy errors.
 *
 * The probe runs exactly once per boot (`main.tsx`); the mode never switches
 * mid-session. `fetchImpl` is injectable for tests only.
 */

export type DatasourceMode = 'local' | 'server'

export interface ResolvedDatasource {
  mode: DatasourceMode
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
    if (res.status === 200) return { mode: 'server' }
    if (res.status === 401) {
      window.location.assign('/ui/login')
      return { mode: 'local' }
    }
    return { mode: 'local' }
  } catch {
    return { mode: 'local' }
  }
}
