import type { ConcatRequest, ConcatResponse } from '../lib/audio/concat-protocol'
import { ffmpegEncoder, parseWavDuration } from '../lib/audio/ffmpeg'
import { getDB } from '../lib/db/connection'

const ctx = self as unknown as Worker

ctx.onmessage = async (event: MessageEvent<ConcatRequest>) => {
  const req = event.data
  try {
    switch (req.type) {
      case 'load': {
        await ffmpegEncoder.load((fraction) => {
          ctx.postMessage({ id: req.id, type: 'loadProgress', fraction } satisfies ConcatResponse)
        })
        ctx.postMessage({ id: req.id, type: 'loaded' } satisfies ConcatResponse)
        break
      }
      case 'concat': {
        const result = await concatAndEncode(req.keys)
        ctx.postMessage({ id: req.id, type: 'success', ...result } satisfies ConcatResponse, [
          result.m4a,
        ])
        break
      }
    }
  } catch (error) {
    console.error('[taletrek] concat worker error:', error)
    ctx.postMessage({
      id: req.id,
      type: 'error',
      message: error instanceof Error ? error.message : 'concat failed',
      ...(error instanceof DOMException ? { name: error.name, code: error.code } : {}),
    } satisfies ConcatResponse)
  }
}

async function concatAndEncode(keys: string[]): Promise<{
  m4a: ArrayBuffer
  paragraphOffsets: number[]
  durations: number[]
  duration: number
}> {
  const db = await getDB()

  let listFile = ''
  const durations: number[] = []
  const offsets: number[] = []
  let cumulative = 0

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    if (!key) throw new Error(`Empty key at index ${i}`)

    // Each db.get uses its own implicit transaction — avoids the
    // "transaction finished" error caused by IDB auto-committing during
    // the FFmpeg writeFile calls between reads.
    const record = await db.get('audioCache', key)
    if (!record) throw new Error(`Audio cache miss for key: ${key}`)

    const wav = await record.blob.arrayBuffer()
    const duration = parseWavDuration(wav)
    durations.push(duration)
    offsets.push(cumulative)
    cumulative += duration

    const filename = `input_${i}.wav`
    listFile += `file '${filename}'\n`

    await ffmpegEncoder.writeFile(filename, new Uint8Array(wav))
  }

  const listFilename = 'list.txt'
  await ffmpegEncoder.writeFile(listFilename, new TextEncoder().encode(listFile))

  const outputFile = 'output.m4a'
  await ffmpegEncoder.exec([
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listFilename,
    '-c:a',
    'aac',
    '-b:a',
    '64k',
    '-f',
    'mp4',
    outputFile,
  ])

  const output = await ffmpegEncoder.readFile(outputFile)
  const bytes = output instanceof Uint8Array ? output : new TextEncoder().encode(output)
  const m4a = bytes.slice().buffer

  return { m4a, paragraphOffsets: offsets, durations, duration: cumulative }
}
