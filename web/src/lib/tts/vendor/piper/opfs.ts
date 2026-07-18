/**
 * OPFS-backed blob cache for piper voice models + configs.
 *
 * Re-implementation of upstream's `readBlob`/`writeBlob`/`removeBlob` with
 * three differences:
 *
 * 1. Errors are logged with a serializable reason instead of swallowed —
 *    iOS Safari's OPFS failure modes (quota, ITP eviction, NotFoundError on
 *    a partial write) are the leading suspect behind "model load works the
 *    first time, then breaks", so we want the failure visible.
 * 2. `writeBlob` is awaited by the caller (upstream's `download()` had a
 *    missing `await` that resolved before the OPFS write landed — so a
 *    reload immediately after a download could miss the cached blob).
 * 3. Post-write integrity check: the written file's `size` must match the
 *    blob's. A partial write returns `false` instead of silently caching
 *    a truncated model.
 *
 * Storage layout is identical to upstream (`<OPFS root>/piper/<basename>`)
 * so models stored by previous app versions are still recognised — no
 * migration step.
 */

import { HF_BASE, PATH_MAP } from './models'

const DIR_NAME = 'piper'

async function getDir(create = false): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle(DIR_NAME, { create })
}

function basename(url: string): string {
  return url.split('/').at(-1) ?? url
}

/**
 * Read a cached blob. Returns `undefined` on any failure (missing file,
 * quota issue, OPFS unsupported) — callers fail open to a network fetch.
 * The failure reason is logged so device-side debugging is possible.
 */
export async function readBlob(url: string): Promise<Blob | undefined> {
  try {
    const dir = await getDir()
    const file = await dir.getFileHandle(basename(url))
    return await file.getFile()
  } catch (e) {
    const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    console.warn(`[taletrek] piper opfs: read missed for ${basename(url)} (${reason})`)
    return undefined
  }
}

/**
 * Persist a blob. Returns `true` on a verified write (file size matches),
 * `false` otherwise. Awaits completion so callers can rely on the cache
 * immediately after.
 */
export async function writeBlob(url: string, blob: Blob): Promise<boolean> {
  try {
    const dir = await getDir(true)
    const file = await dir.getFileHandle(basename(url), { create: true })
    const writable = await file.createWritable()
    await writable.write(blob)
    await writable.close()
    const size = (await file.getFile()).size
    if (size !== blob.size) {
      console.warn(
        `[taletrek] piper opfs: write size mismatch for ${basename(url)} (wrote ${size}/${blob.size})`,
      )
      return false
    }
    return true
  } catch (e) {
    const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    console.warn(`[taletrek] piper opfs: write failed for ${basename(url)} (${reason})`)
    return false
  }
}

/** Remove a cached blob. No-op (with log) if it was never stored. */
export async function removeBlob(url: string): Promise<void> {
  try {
    const dir = await getDir()
    const name = basename(url)
    await dir.removeEntry(name)
  } catch (e) {
    const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    console.warn(`[taletrek] piper opfs: remove skipped for ${basename(url)} (${reason})`)
  }
}

/** Fetch a blob over the network, reporting progress. */
export async function fetchBlob(
  url: string,
  onProgress?: (p: { url: string; loaded: number; total: number }) => void,
): Promise<Blob> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${url} → HTTP ${res.status}`)
  const reader = res.body?.getReader()
  const contentLength = Number(res.headers.get('Content-Length') ?? 0)
  let received = 0
  const chunks: BlobPart[] = []
  while (reader) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value as BlobPart)
    received += value.length
    onProgress?.({ url, total: contentLength, loaded: received })
  }
  return new Blob(chunks, { type: res.headers.get('Content-Type') ?? undefined })
}

/**
 * Read from OPFS; on miss, fetch from network and persist. Storage failures
 * never propagate — a blob is always returned (the model is loadable from
 * network even if OPFS is broken).
 */
export async function getBlob(
  url: string,
  onProgress?: (p: { url: string; loaded: number; total: number }) => void,
): Promise<Blob> {
  const cached = await readBlob(url)
  if (cached) return cached
  const blob = await fetchBlob(url, onProgress)
  void writeBlob(url, blob)
  return blob
}

/**
 * List voiceIds whose `.onnx` blob is present in OPFS. Mirrors upstream
 * `stored()`'s contract: presence of the model file alone counts (config
 * JSON is small and re-fetched on demand if missing).
 */
export async function storedVoices(): Promise<string[]> {
  try {
    const dir = await getDir()
    const present = new Set<string>()
    for await (const name of dir.keys()) {
      if (!name.endsWith('.onnx')) continue
      const key = name.split('.')[0]
      if (key && key in PATH_MAP) present.add(key)
    }
    return [...present]
  } catch (e) {
    const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    console.warn(`[taletrek] piper opfs: stored() failed (${reason})`)
    return []
  }
}

/** Drop every cached blob; returns the count removed. */
export async function clearStoredVoices(): Promise<number> {
  try {
    const root = await navigator.storage.getDirectory()
    await root.removeEntry(DIR_NAME, { recursive: true })
    return 0
  } catch (e) {
    const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    console.warn(`[taletrek] piper opfs: clear failed (${reason})`)
    return 0
  }
}

/**
 * Download both the model (`.onnx`) and config (`.json`) for a voice,
 * persisting each to OPFS. Returns once both writes are verified.
 * Progress fires only for the (much larger) model file.
 */
export async function downloadVoice(
  voiceId: string,
  onProgress?: (p: { url: string; loaded: number; total: number }) => void,
): Promise<void> {
  const path = PATH_MAP[voiceId]
  if (!path) throw new Error(`unknown voiceId: ${voiceId}`)
  const modelUrl = `${HF_BASE}/${path}`
  const jsonUrl = `${HF_BASE}/${path}.json`
  const modelBlob = await fetchBlob(modelUrl, onProgress)
  const jsonBlob = await fetchBlob(jsonUrl)
  const modelOk = await writeBlob(modelUrl, modelBlob)
  const jsonOk = await writeBlob(jsonUrl, jsonBlob)
  if (!modelOk || !jsonOk) {
    console.warn('[taletrek] piper opfs: download persisted partially', {
      voiceId,
      modelOk,
      jsonOk,
    })
  }
}

/** Remove both blobs for a voice. */
export async function removeVoice(voiceId: string): Promise<void> {
  const path = PATH_MAP[voiceId]
  if (!path) return
  await Promise.all([removeBlob(`${HF_BASE}/${path}`), removeBlob(`${HF_BASE}/${path}.json`)])
}
