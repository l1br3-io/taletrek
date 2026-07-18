import { describe, expect, it } from 'vitest'
import { concatWav, pcm2wav } from './pcm'

describe('concatWav', () => {
  /** Build a canonical mono-22050Hz 16-bit WAV from Float32 PCM samples. */
  function makeWav(samples: number[]): ArrayBuffer {
    const pcm = new Float32Array(samples)
    return pcm2wav(pcm, 1, 22050)
  }

  /** Read Int16 PCM samples out of a WAV buffer. */
  function readPcm(buf: ArrayBuffer): number[] {
    const view = new DataView(buf)
    let start = 44
    let offset = 12
    while (offset + 8 <= buf.byteLength) {
      const id = String.fromCharCode(
        view.getUint8(offset),
        view.getUint8(offset + 1),
        view.getUint8(offset + 2),
        view.getUint8(offset + 3),
      )
      const size = view.getUint32(offset + 4, true)
      if (id === 'data') {
        start = offset + 8
        break
      }
      offset += 8 + size + (size % 2)
    }
    const sampleCount = (buf.byteLength - start) / 2
    const out: number[] = []
    for (let i = 0; i < sampleCount; i++) {
      out.push(view.getInt16(start + i * 2, true))
    }
    return out
  }

  it('returns the input unchanged for a single buffer', () => {
    const wav = makeWav([0, 0.5, -0.5])
    const result = concatWav([wav])
    expect(result.byteLength).toBe(wav.byteLength)
  })

  it('returns an empty buffer for zero inputs', () => {
    expect(concatWav([]).byteLength).toBe(0)
  })

  it('concatenates two WAVs into one with correct total size', () => {
    const a = makeWav([0.1, 0.2])
    const b = makeWav([0.3, 0.4, 0.5])
    const merged = concatWav([a, b])
    // Header (44) + (2 + 3) samples × 2 bytes
    expect(merged.byteLength).toBe(44 + 5 * 2)
  })

  it('preserves sample order across the splice', () => {
    const a = makeWav([0.1, 0.2])
    const b = makeWav([0.3, 0.4])
    const merged = concatWav([a, b])
    const samples = readPcm(merged)
    expect(samples).toHaveLength(4)
    // Allow small rounding error from Float32 → Int16.
    expect(samples[0]!).toBeGreaterThan(0)
    expect(samples[3]!).toBeGreaterThan(samples[0]!)
  })

  it('writes the correct RIFF + data chunk sizes in the header', () => {
    const a = makeWav([0.1, 0.2])
    const b = makeWav([0.3, 0.4])
    const merged = concatWav([a, b])
    const view = new DataView(merged)
    // RIFF chunk size at offset 4 = total bytes - 8
    expect(view.getUint32(4, true)).toBe(merged.byteLength - 8)
    // Data chunk size at offset 40 = total sample bytes
    expect(view.getUint32(40, true)).toBe(4 * 2) // 4 samples × 2 bytes
  })

  it('preserves sample rate from the first WAV', () => {
    const a = makeWav([0.1]) // 22050 Hz
    const b = makeWav([0.2])
    const merged = concatWav([a, b])
    const view = new DataView(merged)
    expect(view.getUint32(24, true)).toBe(22050) // sample rate field
  })
})
