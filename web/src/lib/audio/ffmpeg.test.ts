import { describe, expect, it } from 'vitest'
import { MSE_CODEC, parseWavDuration } from './ffmpeg'

/** Build a minimal PCM WAV ArrayBuffer with the given audio data size. */
function makeWav(
  dataSize: number,
  opts: { sampleRate?: number; channels?: number; bitsPerSample?: number } = {},
): ArrayBuffer {
  const { sampleRate = 22050, channels = 1, bitsPerSample = 16 } = opts
  const byteRate = sampleRate * channels * (bitsPerSample / 8)
  const blockAlign = channels * (bitsPerSample / 8)
  const fmtSize = 16
  const fileSize = 4 + (8 + fmtSize) + (8 + dataSize)

  const buf = new ArrayBuffer(8 + (8 + fmtSize) + (8 + dataSize))
  const view = new DataView(buf)
  let p = 0

  // RIFF header
  writeStr(view, p, 'RIFF')
  p += 4
  view.setUint32(p, fileSize, true)
  p += 4
  writeStr(view, p, 'WAVE')
  p += 4

  // fmt chunk
  writeStr(view, p, 'fmt ')
  p += 4
  view.setUint32(p, fmtSize, true)
  p += 4
  view.setUint16(p, 1, true)
  p += 2 // PCM
  view.setUint16(p, channels, true)
  p += 2
  view.setUint32(p, sampleRate, true)
  p += 4
  view.setUint32(p, byteRate, true)
  p += 4
  view.setUint16(p, blockAlign, true)
  p += 2
  view.setUint16(p, bitsPerSample, true)
  p += 2

  // data chunk
  writeStr(view, p, 'data')
  p += 4
  view.setUint32(p, dataSize, true)
  p += 4

  return buf
}

function writeStr(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
}

describe('parseWavDuration', () => {
  it('parses 22050 Hz mono 16-bit WAV (Piper default)', () => {
    // 44100 bytes of data = 1 second at 22050 Hz mono 16-bit
    const wav = makeWav(44100)
    expect(parseWavDuration(wav)).toBeCloseTo(1, 5)
  })

  it('parses 2 seconds of audio', () => {
    const wav = makeWav(88200)
    expect(parseWavDuration(wav)).toBeCloseTo(2, 5)
  })

  it('handles 0.5 seconds', () => {
    const wav = makeWav(22050)
    expect(parseWavDuration(wav)).toBeCloseTo(0.5, 5)
  })

  it('handles different sample rates', () => {
    // 96000 bytes = 1 second at 48000 Hz mono 16-bit (byteRate = 96000)
    const wav = makeWav(96000, { sampleRate: 48000 })
    expect(parseWavDuration(wav)).toBeCloseTo(1, 5)
  })

  it('handles stereo', () => {
    const wav = makeWav(48000, { sampleRate: 24000, channels: 2, bitsPerSample: 16 })
    // byteRate = 24000 * 2 * 2 = 96000; 48000 / 96000 = 0.5s
    expect(parseWavDuration(wav)).toBeCloseTo(0.5, 5)
  })

  it('returns 0 for an ArrayBuffer too small to be a WAV', () => {
    expect(parseWavDuration(new ArrayBuffer(10))).toBe(0)
  })
})

describe('MSE_CODEC', () => {
  it('is the audio-only AAC-LC codec string', () => {
    expect(MSE_CODEC).toBe('audio/mp4; codecs="mp4a.40.2"')
  })
})
