/**
 * PCM → WAV encoder — verbatim logic from upstream `piper-tts-web@1.0.4`'s
 * `pcm2wav`. Extracted as a pure function so the session layer can call it
 * without dragging in the rest of the wrapper.
 *
 * Piper's ONNX model emits raw Float32 PCM (mono, model sample rate — usually
 * 16000–22050 Hz). This wraps it with a 44-byte canonical WAV header so the
 * bytes play through `<audio>` / Web Audio without further work.
 */

/**
 * Encode raw Float32 PCM samples into a WAV ArrayBuffer.
 *
 * Samples outside [-1, 1] are clamped to the 16-bit range. `numChannels` is
 * always 1 in practice (Piper is mono) but is kept as a parameter for parity
 * with upstream.
 */
export function pcm2wav(pcm: Float32Array, numChannels: number, sampleRate: number): ArrayBuffer {
  const bufferLength = pcm.length
  const headerLength = 44
  const view = new DataView(new ArrayBuffer(bufferLength * numChannels * 2 + headerLength))
  view.setUint32(0, 1179011410, true) // "RIFF"
  view.setUint32(4, view.buffer.byteLength - 8, true)
  view.setUint32(8, 1163280727, true) // "WAVE"
  view.setUint32(12, 544501094, true) // "fmt "
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, numChannels * 2 * sampleRate, true)
  view.setUint16(32, numChannels * 2, true)
  view.setUint16(34, 16, true)
  view.setUint32(36, 1635017060, true) // "data"
  view.setUint32(40, 2 * bufferLength, true)
  let p = headerLength
  for (let i = 0; i < bufferLength; i++) {
    const v = pcm[i] ?? 0
    if (v >= 1) view.setInt16(p, 32767, true)
    else if (v <= -1) view.setInt16(p, -32768, true)
    else view.setInt16(p, (v * 32768) | 0, true)
    p += 2
  }
  return view.buffer
}

/**
 * Concatenate multiple canonical-mono-16-bit WAV ArrayBuffers into one WAV.
 * Used by `engine.synthesize` to stitch chunked-synthesis results back into a
 * single Blob (long paragraphs are split via `splitForSpeech` to bound peak
 * memory per inference call — see `MAX_SYNTH_CHARS`).
 *
 * Assumes all inputs share the same sample rate + channel count (Piper always
 * does — one session = one voice model = one config). The output copies the
 * first input's `fmt ` chunk verbatim and rewrites the `data` chunk size +
 * RIFF size to cover the concatenated payload. PCM bytes are concatenated
 * directly without re-decoding — a true splice at the byte level.
 */
export function concatWav(buffers: ArrayBuffer[]): ArrayBuffer {
  if (buffers.length === 0) return new ArrayBuffer(0)
  if (buffers.length === 1) return buffers[0]!
  const first = buffers[0]!

  const dataOffsets: number[] = []
  let totalDataBytes = 0
  for (const buf of buffers) {
    const offset = findDataOffset(buf)
    dataOffsets.push(offset)
    totalDataBytes += buf.byteLength - offset
  }

  // Reuse the first buffer's header (sample rate, channels, bits per sample).
  const headerSrc = new Uint8Array(first.slice(0, dataOffsets[0]!))
  const out = new Uint8Array(headerSrc.byteLength + totalDataBytes)
  out.set(headerSrc, 0)

  // Rewrite the two size fields: RIFF chunk size (offset 4) and `data` chunk
  // size (offset 40 in canonical header, but locate the `data` chunk properly
  // in case the input has extra chunks before it).
  const view = new DataView(out.buffer)
  view.setUint32(4, 36 + totalDataBytes, true) // RIFF size = total - 8
  // Find `data` chunk in the assembled header + fix its size.
  let scan = 12
  while (scan + 8 <= headerSrc.byteLength) {
    const id = String.fromCharCode(
      view.getUint8(scan),
      view.getUint8(scan + 1),
      view.getUint8(scan + 2),
      view.getUint8(scan + 3),
    )
    const size = view.getUint32(scan + 4, true)
    if (id === 'data') {
      view.setUint32(scan + 4, totalDataBytes, true)
      break
    }
    scan += 8 + size + (size % 2)
  }

  // Append PCM bytes from each input.
  let p = headerSrc.byteLength
  for (let i = 0; i < buffers.length; i++) {
    const src = new Uint8Array(buffers[i]!.slice(dataOffsets[i]!))
    out.set(src, p)
    p += src.byteLength
  }
  return out.buffer
}

/**
 * Locate the start of the PCM data payload (byte offset of the first sample,
 * i.e. 8 bytes past the `data` FourCC). Scans the chunk table; falls back to
 * the canonical 44 if the structure is unexpected — same fallback as
 * `parseWavDuration` in `lib/audio/ffmpeg.ts`.
 */
function findDataOffset(buf: ArrayBuffer): number {
  if (buf.byteLength < 12) return Math.min(buf.byteLength, 44)
  const view = new DataView(buf)
  let offset = 12
  while (offset + 8 <= buf.byteLength) {
    const id = String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    )
    const size = view.getUint32(offset + 4, true)
    if (id === 'data') return offset + 8
    offset += 8 + size + (size % 2)
  }
  return Math.min(buf.byteLength, 44)
}
