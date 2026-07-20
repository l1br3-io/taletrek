import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetForTests,
  type BeforeInstallPromptEvent,
  getInstallState,
  subscribe,
  triggerInstallPrompt,
} from './install-prompt'

/** Synthetic BeforeInstallPromptEvent with mockable prompt/userChoice. */
function bipEvent(): BeforeInstallPromptEvent {
  const e = new Event('beforeinstallprompt') as BeforeInstallPromptEvent
  Object.defineProperty(e, 'prompt', {
    value: vi.fn().mockResolvedValue(undefined),
    configurable: true,
  })
  Object.defineProperty(e, 'userChoice', {
    value: Promise.resolve({ outcome: 'accepted' }),
    configurable: true,
  })
  return e
}

beforeEach(() => {
  _resetForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('install-prompt singleton', () => {
  it('captures beforeinstallprompt fired before any subscriber mounts', () => {
    // Fire the event with no subscribers yet — the module-load listener
    // should still capture it.
    window.dispatchEvent(bipEvent())
    expect(getInstallState().captured).not.toBeNull()
  })

  it('notifies subscribers on capture and on triggerInstallPrompt', async () => {
    const fn = vi.fn()
    const unsubscribe = subscribe(fn)
    expect(fn).not.toHaveBeenCalled()

    window.dispatchEvent(bipEvent())
    expect(fn).toHaveBeenCalledTimes(1)
    expect(getInstallState().captured).not.toBeNull()

    await triggerInstallPrompt()
    expect(fn).toHaveBeenCalledTimes(2)
    expect(getInstallState().captured).toBeNull()

    unsubscribe()
  })

  it('triggerInstallPrompt is a no-op when no event is captured', async () => {
    const fn = vi.fn()
    subscribe(fn)
    await triggerInstallPrompt()
    expect(fn).not.toHaveBeenCalled()
    expect(getInstallState().captured).toBeNull()
  })

  it('appinstalled clears the captured event and flips installed', () => {
    window.dispatchEvent(bipEvent())
    expect(getInstallState().captured).not.toBeNull()

    window.dispatchEvent(new Event('appinstalled'))
    expect(getInstallState().captured).toBeNull()
    expect(getInstallState().installed).toBe(true)
  })
})
