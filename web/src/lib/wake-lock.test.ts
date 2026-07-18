import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireUploadWakeLock } from './wake-lock'

/**
 * Minimal WakeLockSentinel stub matching the DOM API surface used by
 * wake-lock.ts: `released`, `release()`, `onrelease`.
 */
interface SentinelStub {
  released: boolean
  onrelease: (() => void) | null
  release: ReturnType<typeof vi.fn>
}

interface WakeLockStub {
  request: ReturnType<typeof vi.fn>
}

function makeSentinel(): SentinelStub {
  return {
    released: false,
    onrelease: null,
    release: vi.fn(async () => {}),
  }
}

function installWakeLock(stub: WakeLockStub): void {
  Object.defineProperty(navigator, 'wakeLock', {
    value: stub,
    configurable: true,
  })
}

function removeWakeLock(): void {
  // @ts-expect-error delete non-optional navigator prop for test isolation
  delete navigator.wakeLock
}

function setVisible(visible: boolean): void {
  Object.defineProperty(document, 'visibilityState', {
    value: visible ? 'visible' : 'hidden',
    configurable: true,
  })
}

function dispatchVisibility(): void {
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  setVisible(true)
})

afterEach(() => {
  removeWakeLock()
  vi.restoreAllMocks()
})

describe('acquireUploadWakeLock', () => {
  it('returns a no-op handle when navigator.wakeLock is unsupported', async () => {
    removeWakeLock()
    const handle = await acquireUploadWakeLock()
    await expect(handle.release()).resolves.toBeUndefined()
  })

  it('requests a screen sentinel on the happy path', async () => {
    const sentinel = makeSentinel()
    const stub: WakeLockStub = { request: vi.fn(async () => sentinel) }
    installWakeLock(stub)
    const handle = await acquireUploadWakeLock()
    expect(stub.request).toHaveBeenCalledWith('screen')
    await handle.release()
    expect(sentinel.release).toHaveBeenCalled()
  })

  it('returns a no-op handle when document is hidden at acquire time', async () => {
    const stub: WakeLockStub = { request: vi.fn(async () => makeSentinel()) }
    installWakeLock(stub)
    setVisible(false)
    const handle = await acquireUploadWakeLock()
    expect(stub.request).not.toHaveBeenCalled()
    await handle.release()
  })

  it('returns a no-op handle when request() rejects (never throws)', async () => {
    const stub: WakeLockStub = {
      request: vi.fn(async () => {
        throw new DOMException('NotAllowedError')
      }),
    }
    installWakeLock(stub)
    const handle = await acquireUploadWakeLock()
    await expect(handle.release()).resolves.toBeUndefined()
  })

  it('re-acquires on visibilitychange → visible', async () => {
    const first = makeSentinel()
    const second = makeSentinel()
    let calls = 0
    const stub: WakeLockStub = {
      request: vi.fn(async () => {
        calls += 1
        return calls === 1 ? first : second
      }),
    }
    installWakeLock(stub)

    const handle = await acquireUploadWakeLock()
    // Browser auto-releases the first sentinel (e.g., user switched tabs),
    // then the user comes back.
    first.onrelease?.()
    setVisible(false)
    dispatchVisibility()
    setVisible(true)
    dispatchVisibility()

    // Let the async reacquire resolve.
    await new Promise((r) => setTimeout(r, 0))

    expect(stub.request).toHaveBeenCalledTimes(2)
    await handle.release()
    expect(second.release).toHaveBeenCalled()
  })

  it('re-acquires when sentinel fires onrelease without visibility change', async () => {
    const first = makeSentinel()
    const second = makeSentinel()
    let calls = 0
    const stub: WakeLockStub = {
      request: vi.fn(async () => {
        calls += 1
        return calls === 1 ? first : second
      }),
    }
    installWakeLock(stub)

    const handle = await acquireUploadWakeLock()
    // Browser drops the sentinel on its own (OEM power-save, etc.).
    first.onrelease?.()

    await new Promise((r) => setTimeout(r, 0))

    expect(stub.request).toHaveBeenCalledTimes(2)
    await handle.release()
  })

  it('does not re-acquire after deliberate release', async () => {
    const first = makeSentinel()
    const stub: WakeLockStub = { request: vi.fn(async () => first) }
    installWakeLock(stub)

    const handle = await acquireUploadWakeLock()
    await handle.release()
    expect(first.release).toHaveBeenCalled()

    // visibilitychange after deliberate release should be a no-op.
    setVisible(false)
    dispatchVisibility()
    setVisible(true)
    dispatchVisibility()
    await new Promise((r) => setTimeout(r, 0))

    expect(stub.request).toHaveBeenCalledTimes(1)
  })

  it('release tolerates sentinel.release() throwing', async () => {
    const sentinel: SentinelStub = {
      released: false,
      onrelease: null,
      release: vi.fn(async () => {
        throw new Error('already released')
      }),
    }
    const stub: WakeLockStub = { request: vi.fn(async () => sentinel) }
    installWakeLock(stub)

    const handle = await acquireUploadWakeLock()
    await expect(handle.release()).resolves.toBeUndefined()
  })
})
