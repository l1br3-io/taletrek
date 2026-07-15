import { FFmpeg } from '@ffmpeg/ffmpeg'

/**
 * FFmpeg WASM wrapper — loads the ~30MB core from OPFS (CDN download on first
 * mobile use) and encodes PCM WAV → fragmented MP4 for mobile MSE streaming.
 *
 * Runs inside the encode worker (separate from the TTS worker) so Piper
 * inference and FFmpeg encoding don't block each other.
 *
 * Single-threaded core (avoids SharedArrayBuffer / COOP/COEP — ADR-0006).
 */

/** CDN base for the FFmpeg core WASM files (esm distribution for Vite). */
const CORE_VERSION = '0.12.10'
const CDN_BASE = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`

/** OPFS directory + file names for the cached core. */
const OPFS_DIR = 'ffmpeg-core'
const CORE_JS = 'ffmpeg-core.js'
const CORE_WASM = 'ffmpeg-core.wasm'

/** MSE codec string (AAC-LC audio-only). */
export const MSE_CODEC = 'audio/mp4; codecs="mp4a.40.2"'

/** Load progress callback (0–1 fraction of the ~30MB core download). */
export type LoadProgressFn = (fraction: number) => void

class FfmpegEncoder {
  private ffmpegInstance: FFmpeg | null = null
  private _loaded = false
  private loadPromise: Promise<void> | null = null

  private get ffmpeg(): FFmpeg {
    if (!this.ffmpegInstance) this.ffmpegInstance = new FFmpeg()
    return this.ffmpegInstance
  }

  get loaded(): boolean {
    return this._loaded
  }

  writeFile(name: string, data: Uint8Array): Promise<boolean> {
    return this.ffmpeg.writeFile(name, data)
  }

  exec(args: string[]): Promise<number> {
    return this.ffmpeg.exec(args)
  }

  readFile(name: string): Promise<Uint8Array | string> {
    return this.ffmpeg.readFile(name)
  }

  terminate(): void {
    this.ffmpeg.terminate()
    this._loaded = false
    this.ffmpegInstance = null
  }

  /**
   * Load the FFmpeg core from OPFS. On first use, downloads `ffmpeg-core.js` +
   * `ffmpeg-core.wasm` (~30MB) from CDN to OPFS, then loads via blob URLs.
   * Subsequent loads read directly from OPFS (offline-capable).
   */
  async load(onProgress?: LoadProgressFn): Promise<void> {
    if (this._loaded) return
    if (this.loadPromise) return this.loadPromise

    console.log('[taletrek] ffmpeg: loading core...')
    this.loadPromise = this.doLoad(onProgress)
    try {
      await this.loadPromise
      this._loaded = true
      console.log('[taletrek] ffmpeg: core loaded')
    } finally {
      this.loadPromise = null
    }
  }

  private async doLoad(onProgress?: LoadProgressFn): Promise<void> {
    const urls = await this.resolveCoreURLs(onProgress)
    console.log('[taletrek] ffmpeg: calling ffmpeg.load()...')
    await this.ffmpeg.load({ coreURL: urls.coreURL, wasmURL: urls.wasmURL })
    console.log('[taletrek] ffmpeg: ffmpeg.load() resolved')
  }

  /**
   * Return blob URLs for the core JS + WASM. Checks OPFS first; downloads from
   * CDN to OPFS on miss. Blob URLs keep the core alive in-memory for the
   * session.
   */
  private async resolveCoreURLs(
    onProgress?: LoadProgressFn,
  ): Promise<{ coreURL: string; wasmURL: string }> {
    console.log('[taletrek] ffmpeg: checking OPFS...')
    const cached = await this.readFromOpfs()
    if (cached) {
      console.log('[taletrek] ffmpeg: core found in OPFS')
      return {
        coreURL: URL.createObjectURL(new Blob([cached.js], { type: 'text/javascript' })),
        wasmURL: URL.createObjectURL(new Blob([cached.wasm], { type: 'application/wasm' })),
      }
    }
    console.log('[taletrek] ffmpeg: not in OPFS — downloading from CDN (~30MB)...')
    const downloaded = await this.downloadCore(onProgress)
    console.log('[taletrek] ffmpeg: downloaded, creating blob URLs')
    return {
      coreURL: URL.createObjectURL(new Blob([downloaded.js], { type: 'text/javascript' })),
      wasmURL: URL.createObjectURL(new Blob([downloaded.wasm], { type: 'application/wasm' })),
    }
  }

  /** Read cached core from OPFS, or return null if not present. */
  private async readFromOpfs(): Promise<{ js: ArrayBuffer; wasm: ArrayBuffer } | null> {
    try {
      const root = await navigator.storage.getDirectory()
      const dir = await root.getDirectoryHandle(OPFS_DIR)
      const jsFile = await (await dir.getFileHandle(CORE_JS)).getFile()
      const wasmFile = await (await dir.getFileHandle(CORE_WASM)).getFile()
      return { js: await jsFile.arrayBuffer(), wasm: await wasmFile.arrayBuffer() }
    } catch {
      return null
    }
  }

  /** Download core from CDN to OPFS, reporting progress. Returns the buffers. */
  private async downloadCore(
    onProgress?: LoadProgressFn,
  ): Promise<{ js: ArrayBuffer; wasm: ArrayBuffer }> {
    const [js, wasm] = await Promise.all([
      this.fetchWithProgress(`${CDN_BASE}/${CORE_JS}`, onProgress, 0, 0.05),
      this.fetchWithProgress(`${CDN_BASE}/${CORE_WASM}`, onProgress, 0.05, 1),
    ])
    await this.writeToOpfs(js, wasm)
    return { js, wasm }
  }

  /** Fetch a URL as ArrayBuffer with progress reporting over a sub-range. */
  private async fetchWithProgress(
    url: string,
    onProgress: LoadProgressFn | undefined,
    startFraction: number,
    endFraction: number,
  ): Promise<ArrayBuffer> {
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`Failed to download FFmpeg core: ${resp.status}`)
    const reader = resp.body?.getReader()
    if (!reader) {
      onProgress?.(endFraction)
      return await resp.arrayBuffer()
    }
    const total = Number(resp.headers.get('Content-Length')) || 0
    const chunks: Uint8Array[] = []
    let received = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      received += value.byteLength
      if (total > 0) {
        const withinRange = received / total
        onProgress?.(startFraction + withinRange * (endFraction - startFraction))
      }
    }
    onProgress?.(endFraction)
    const merged = new Uint8Array(received)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    return merged.buffer
  }

  /** Write core buffers to OPFS for offline use. */
  private async writeToOpfs(js: ArrayBuffer, wasm: ArrayBuffer): Promise<void> {
    try {
      const root = await navigator.storage.getDirectory()
      const dir = await root.getDirectoryHandle(OPFS_DIR, { create: true })
      const jsWritable = await (await dir.getFileHandle(CORE_JS, { create: true })).createWritable()
      await jsWritable.write(js)
      await jsWritable.close()
      const wasmWritable = await (
        await dir.getFileHandle(CORE_WASM, { create: true })
      ).createWritable()
      await wasmWritable.write(wasm)
      await wasmWritable.close()
    } catch {
      // OPFS write failure is non-fatal — the core is already in-memory via
      // blob URLs for this session. Next session will re-download.
    }
  }
}

/**
 * Parse the audio duration (seconds) from a PCM WAV ArrayBuffer by reading the
 * `fmt` and `data` chunk headers. Piper outputs 22050 Hz mono 16-bit WAV.
 */
export function parseWavDuration(data: ArrayBuffer): number {
  if (data.byteLength < 44) return 0
  const view = new DataView(data)

  let sampleRate = 0
  let channels = 0
  let bitsPerSample = 0

  // Scan chunks starting at offset 12 (after "RIFF" size "WAVE").
  let offset = 12
  while (offset < data.byteLength - 8) {
    const id = readFourCC(view, offset)
    const size = view.getUint32(offset + 4, true)
    if (id === 'fmt ') {
      channels = view.getUint16(offset + 10, true)
      sampleRate = view.getUint32(offset + 12, true)
      bitsPerSample = view.getUint16(offset + 22, true)
    } else if (id === 'data') {
      const byteRate = sampleRate * channels * (bitsPerSample / 8)
      return byteRate > 0 ? size / byteRate : 0
    }
    offset += 8 + size + (size % 2)
  }
  return 0
}

function readFourCC(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  )
}

/** Module-level singleton — one FFmpeg instance per worker. */
export const ffmpegEncoder = new FfmpegEncoder()
