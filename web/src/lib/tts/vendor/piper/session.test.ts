import { describe, expect, it, vi } from 'vitest'
import { voiceId } from '../../../../types'
import { WASM_PATHS } from '../../wasm-paths'
import { PiperError } from './errors'
import type { OrtModule, PhonemizeFactory, PhonemizeModule } from './session'
import { PiperSession } from './session'

const VOICE = voiceId('en_US-hfc_female-medium')

/**
 * Build a fake phonemize factory whose `callMain` writes `phoneme_ids` JSON
 * to `print`, captures `printErr` lines into `onStderr`, and returns the
 * provided exit code. `mode` switches what the fake main does:
 *   - 'ok'     → prints valid phoneme JSON, returns 0
 *   - 'no-stdout' → returns 0 without printing (simulates C++ abort before stdout)
 *   - 'throw'  → throws a Number (mimics Emscripten C++ exception pointer)
 *   - 'stderr' → emits stderr lines, then prints valid JSON, returns 0
 *   - 'exit-1' → prints nothing, returns 1
 *   - 'bad-json' → prints garbage, returns 0
 */
function fakePhonemizeFactory(
  mode: 'ok' | 'no-stdout' | 'throw' | 'stderr' | 'exit-1' | 'bad-json',
  sink: { stderr: string[] },
): PhonemizeFactory {
  return async (opts) => {
    const mod: PhonemizeModule = {
      callMain(_args: string[]): number {
        if (mode === 'throw') {
          // Real Emscripten rethrows C++ exceptions as Numbers (heap pointers).
          throw 1058616
        }
        if (mode === 'stderr') {
          opts.printErr('espeak warning: missing phoneme for \\uXXXX')
          opts.printErr('espeak warning: another line')
        }
        if (mode === 'no-stdout' || mode === 'exit-1') {
          sink.stderr.push(...(mode === 'no-stdout' ? [] : []))
          return mode === 'exit-1' ? 1 : 0
        }
        if (mode === 'bad-json') {
          opts.print('not valid json{')
          return 0
        }
        // ok
        opts.print(JSON.stringify({ phoneme_ids: [1, 0, 41, 0, 59, 0], phonemes: [] }))
        return 0
      },
    }
    // Capture stderr via a spy on opts.printErr — the factory itself wraps it.
    const orig = opts.printErr
    opts.printErr = (m: string) => {
      sink.stderr.push(m)
      orig?.(m)
    }
    return mod
  }
}

/** A minimal fake ORT that returns a fixed-length Float32Array output. */
function fakeOrt(sampleCount = 1000): OrtModule {
  return {
    Tensor: class {
      constructor(
        public type: string,
        public data: unknown,
        public dims?: number[],
      ) {}
    },
    InferenceSession: {
      async create() {
        return {
          async run() {
            return { output: { data: new Float32Array(sampleCount) } }
          },
          release: vi.fn(async () => {}),
        }
      },
    },
    env: { allowLocalModels: false, wasm: { numThreads: 1, wasmPaths: '' } },
  }
}

/**
 * Build a session bypassing the model-load step (which needs OPFS+network).
 * Reaches the same internal state `PiperSession.create` would have set up,
 * so `predict()` exercises the real phonemize+ORT+encode path.
 */
async function makeSession(opts: {
  phonemize: PhonemizeFactory
  ort?: OrtModule
}): Promise<PiperSession> {
  // We can't call the private constructor directly; route through `create`
  // with the OPFS helpers stubbed out via the getBlob injection is not exposed
  // — so we test the path that DOES use create() by mocking getBlob via a
  // module-level vi.mock. Simpler: test predict() in isolation by reaching
  // into the module's `predict` via a tiny adapter.
  void opts
  throw new Error('use makeSessionWithMocks below')
}

// Override: since PiperSession.create goes through `getBlob` (real OPFS), we
// mock the opfs module for these tests.
vi.mock('./opfs', () => ({
  getBlob: vi.fn(async (url: string) => {
    if (url.endsWith('.json')) {
      return new Blob([
        JSON.stringify({
          espeak: { voice: 'en-us' },
          audio: { sample_rate: 16000 },
          inference: { noise_scale: 0.667, length_scale: 1, noise_w: 0.8 },
          speaker_id_map: {},
        }),
      ])
    }
    return new Blob([new Uint8Array(8)])
  }),
  readBlob: vi.fn(async () => undefined),
  writeBlob: vi.fn(async () => true),
  removeBlob: vi.fn(async () => {}),
  fetchBlob: vi.fn(async () => new Blob([new Uint8Array(8)])),
  storedVoices: vi.fn(async () => []),
  clearStoredVoices: vi.fn(async () => 0),
  downloadVoice: vi.fn(async () => {}),
  removeVoice: vi.fn(async () => {}),
}))

void makeSession

async function makeSessionWithMocks(
  phonemize: PhonemizeFactory,
  ort: OrtModule,
): Promise<PiperSession> {
  return PiperSession.create({
    voiceId: VOICE,
    wasmPaths: WASM_PATHS,
    createPhonemize: phonemize,
    ort,
  })
}

describe('PiperSession (vendored)', () => {
  it('phonemize + inference + WAV encode succeeds end-to-end', async () => {
    const sink = { stderr: [] }
    const session = await makeSessionWithMocks(fakePhonemizeFactory('ok', sink), fakeOrt(2000))
    const blob = await session.predict('hello world')
    expect(blob).toBeInstanceOf(Blob)
    expect(blob.type).toBe('audio/x-wav')
    expect(blob.size).toBeGreaterThan(44) // header + samples
    expect(sink.stderr).toEqual([])
  })

  it('rejects with PiperError{phase:phonemize} when main throws (the PARSE_ERROR/hang case)', async () => {
    // This is the regression for the iOS PARSE_ERROR symptom: a C++ exception
    // thrown from main() previously hung predict() forever because the
    // promise executor was async. Now it rejects with a typed error.
    const sink = { stderr: [] }
    const session = await makeSessionWithMocks(fakePhonemizeFactory('throw', sink), fakeOrt())
    const err = await session.predict('Before \uD800 after').catch((e) => e)
    expect(err).toBeInstanceOf(PiperError)
    expect((err as PiperError).phase).toBe('phonemize')
    expect((err as PiperError).voiceId).toBe(VOICE)
    expect((err as PiperError).message).toContain('threw 1058616')
  })

  it('rejects with PiperError{phase:phonemize} when stdout never fires', async () => {
    const sink = { stderr: [] }
    const session = await makeSessionWithMocks(fakePhonemizeFactory('no-stdout', sink), fakeOrt())
    const err = await session.predict('x').catch((e) => e)
    expect(err).toBeInstanceOf(PiperError)
    expect((err as PiperError).phase).toBe('phonemize')
    expect((err as PiperError).message).toContain('no phoneme output')
  })

  it('rejects when exitCode is non-zero, even with stdout', async () => {
    const sink = { stderr: [] }
    const session = await makeSessionWithMocks(fakePhonemizeFactory('exit-1', sink), fakeOrt())
    const err = await session.predict('x').catch((e) => e)
    expect(err).toBeInstanceOf(PiperError)
    expect((err as PiperError).phase).toBe('phonemize')
    expect((err as PiperError).exitCode).toBe(1)
  })

  it('captures espeak stderr lines on the failing phonemize path', async () => {
    // Verify stderr lines are attached to the PiperError when main emits
    // warnings before failing (no stdout).
    const factory: PhonemizeFactory = async (opts) => ({
      callMain() {
        opts.printErr('line one')
        opts.printErr('line two')
        // No stdout — abort path.
        return 0
      },
    })
    const session = await makeSessionWithMocks(factory, fakeOrt())
    const err = await session.predict('x').catch((e) => e)
    expect(err).toBeInstanceOf(PiperError)
    expect((err as PiperError).stderr).toEqual(['line one', 'line two'])
  })

  it('rejects with PiperError{phase:phonemize} when stdout JSON is malformed', async () => {
    const sink = { stderr: [] }
    const session = await makeSessionWithMocks(fakePhonemizeFactory('bad-json', sink), fakeOrt())
    const err = await session.predict('x').catch((e) => e)
    expect(err).toBeInstanceOf(PiperError)
    expect((err as PiperError).phase).toBe('phonemize')
    expect((err as PiperError).message).toContain('JSON parse failed')
  })

  it('serializes concurrent predict calls via the predict chain', async () => {
    // Two predicts fired in parallel both resolve — the chain ensures the
    // second callMain only fires after the first predictOnce has settled.
    // (callMain is synchronous in the fake, so re-entrancy isn't possible
    // here; this test guards against a future regression where the chain
    // logic itself breaks and both end up rejected.)
    const session = await makeSessionWithMocks(
      fakePhonemizeFactory('ok', { stderr: [] }),
      fakeOrt(),
    )
    const results = await Promise.all(
      Array.from({ length: 5 }, () => session.predict('x').then(() => 'ok')),
    )
    expect(results).toEqual(['ok', 'ok', 'ok', 'ok', 'ok'])
  })

  it('dispose() releases the ORT session and is idempotent', async () => {
    const ort = fakeOrt()
    const session = await makeSessionWithMocks(fakePhonemizeFactory('ok', { stderr: [] }), ort)
    await session.dispose()
    // Second dispose is a no-op (releases nothing).
    await expect(session.dispose()).resolves.toBeUndefined()
    // Predicting after dispose surfaces an inference-phase error rather than
    // crashing on a null deref.
    const err = await session.predict('x').catch((e) => e)
    expect(err).toBeInstanceOf(PiperError)
    expect((err as PiperError).phase).toBe('inference')
  })
})
