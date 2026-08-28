import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveDatasourceMode } from './resolve'

/**
 * `window.location` is unforgeable in jsdom — `vi.spyOn` fails with "Cannot
 * redefine property". The delete-then-reassign dance works and lets the
 * 401-redirect be observed via a mock `assign`.
 */
let originalLocation: Location
let assignMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  originalLocation = window.location
  assignMock = vi.fn()
  delete (window as unknown as Record<string, unknown>).location
  ;(window as unknown as Record<string, unknown>).location = {
    ...originalLocation,
    assign: assignMock,
  }
})

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).location
  ;(window as unknown as Record<string, unknown>).location = originalLocation
})

function statusResponse(status: number, body = '{"ok":true}'): Response {
  return new Response(body, { status })
}

describe('resolveDatasourceMode', () => {
  it('authed 200 → server mode (single same-origin no-store probe)', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(statusResponse(200))
    const result = await resolveDatasourceMode(fetchMock)
    expect(result).toEqual({ mode: 'server' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/session', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
    })
    expect(assignMock).not.toHaveBeenCalled()
  })

  it('401 → redirects to /ui/login and falls through to local mode', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(statusResponse(401))
    const result = await resolveDatasourceMode(fetchMock)
    expect(assignMock).toHaveBeenCalledWith('/ui/login')
    expect(result).toEqual({ mode: 'local' })
  })

  it('404 (no server at this origin) → local mode silently', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(statusResponse(404, 'not found'))
    const result = await resolveDatasourceMode(fetchMock)
    expect(result).toEqual({ mode: 'local' })
    expect(assignMock).not.toHaveBeenCalled()
  })

  it('5xx → local mode (safe degradation, never a crash)', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(statusResponse(502, 'bad gateway'))
    await expect(resolveDatasourceMode(fetchMock)).resolves.toEqual({ mode: 'local' })
    expect(assignMock).not.toHaveBeenCalled()
  })

  it('network error (unreachable origin) → local mode, no throw', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'))
    await expect(resolveDatasourceMode(fetchMock)).resolves.toEqual({ mode: 'local' })
    expect(assignMock).not.toHaveBeenCalled()
  })
})
