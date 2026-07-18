import { describe, expect, it } from 'vitest'
import { formatError } from './format-error'

describe('formatError', () => {
  it('formats a plain Error with name + message', () => {
    const out = formatError(new Error('boom'))
    expect(out.startsWith('Error: boom')).toBe(true)
  })

  it('includes the DOMException name (code is best-effort and engine-dependent)', () => {
    const out = formatError(new DOMException('not found', 'NotFoundError'))
    expect(out).toContain('NotFoundError')
    expect(out).toContain('not found')
  })

  it('omits code 0 (the default for non-DOMException Errors)', () => {
    const out = formatError(new Error('plain'))
    expect(out).not.toContain('code')
  })

  it('preserves a custom error name', () => {
    class MyErr extends Error {
      constructor() {
        super('custom')
        this.name = 'MyErr'
      }
    }
    expect(formatError(new MyErr())).toMatch(/^MyErr: custom/)
  })

  it('annotates a PiperError-shaped object with its phase via name', () => {
    const e = Object.assign(new Error('phonemize failed'), {
      name: 'PiperError',
      phase: 'phonemize',
    })
    expect(formatError(e)).toMatch(/^PiperError: phonemize failed/)
  })

  it('falls back to String() for non-Error throws (e.g. WASM-thrown numbers)', () => {
    expect(formatError(1058616)).toBe('1058616')
    expect(formatError('bare string')).toBe('bare string')
  })

  it('annotates the constructor name for boxed non-Error throws', () => {
    expect(formatError(new TypeError('bad type'))).toMatch(/^TypeError: bad type/)
  })
})
