import {
  CreateWebWorkerMLCEngine,
  prebuiltAppConfig,
  hasModelInCache,
  deleteModelAllInfoInCache,
} from '@mlc-ai/web-llm'
import type { MLCEngineInterface, InitProgressReport, AppConfig } from '@mlc-ai/web-llm'

// WebLLM doesn't re-export the OpenAI message type; the runtime shape is what matters.
type ChatMessage = { role: 'system' | 'user'; content: string }

// Grounded in the installed package's prebuiltAppConfig (WebLLM 0.2.84).
// Canonical id uses lowercase quant + `-MLC` suffix (plan's `Q4f32_1` was approximate).
const MODEL_ID = 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC'
const CACHE_BACKEND = 'opfs'
const APP_CONFIG: AppConfig = { ...prebuiltAppConfig, cacheBackend: CACHE_BACKEND }

type TransformOp =
  | { kind: 'cleanup' }
  | { kind: 'translate'; target: string }
  | { kind: 'summarize'; ratio: number }
  | { kind: 'simplify'; level: number }
  | { kind: 'hints' }

const $ = (id: string) => document.getElementById(id) as HTMLElement
const log = (msg: unknown) => {
  const el = $('log') as HTMLPreElement
  const line = typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2)
  el.textContent += `${line}\n`
  el.scrollTop = el.scrollHeight
  console.log('[spike]', msg)
}
const setLoadStatus = (s: string) => ($('loadStatus').textContent = s)
const setOpStatus = (s: string) => ($('opStatus').textContent = s)

let engine: MLCEngineInterface | null = null

const loadBtn = $('load') as HTMLButtonElement
const unloadBtn = $('unload') as HTMLButtonElement
const clearBtn = $('clearCache') as HTMLButtonElement
const abortBtn = $('abort') as HTMLButtonElement
const loadBar = $('loadBar') as HTMLElement
const loadPct = $('loadPct') as HTMLElement
const outputEl = $('output') as HTMLPreElement

function memSnapshot(): string {
  const perf = performance as Performance & {
    memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number }
  }
  const m = perf.memory
  if (!m) return 'memory API unavailable (non-Chromium)'
  return `heap ${(m.usedJSHeapSize / 1024 / 1024).toFixed(1)} MiB / limit ${(m.jsHeapSizeLimit / 1024 / 1024).toFixed(0)} MiB`
}

async function renderDiag() {
  const diag: Record<string, unknown> = {
    ua: navigator.userAgent.slice(0, 90),
    webgpu: !!navigator.gpu,
    crossOriginIsolated: typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated,
    opfs: !!navigator.storage?.getDirectory,
    cacheBackend: CACHE_BACKEND,
    modelCached: await hasModelInCache(MODEL_ID, APP_CONFIG).catch((e) => `err: ${String(e)}`),
    mem: memSnapshot(),
  }
  const grid = $('diag')
  grid.innerHTML = ''
  for (const [k, v] of Object.entries(diag)) {
    const kk = document.createElement('div')
    kk.className = 'k'
    kk.textContent = k
    const vv = document.createElement('div')
    vv.textContent = typeof v === 'string' ? v : JSON.stringify(v)
    grid.append(kk, vv)
  }
  log({ event: 'diag', ...diag })
}

async function loadModel() {
  if (engine) {
    setLoadStatus('already loaded')
    return
  }
  loadBtn.disabled = true
  const t0 = performance.now()
  setLoadStatus('loading…')
  loadBar.style.width = '0%'
  try {
    engine = await CreateWebWorkerMLCEngine(
      new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
      MODEL_ID,
      {
        initProgressCallback: (r: InitProgressReport) => {
          const pct = Math.round(r.progress * 100)
          loadBar.style.width = `${pct}%`
          loadPct.textContent = `${pct}% — ${r.text}`
        },
        appConfig: APP_CONFIG,
      },
    )
    const ms = performance.now() - t0
    setLoadStatus(`loaded in ${ms.toFixed(0)} ms`)
    log({ event: 'load.done', ms: ms.toFixed(0), modelId: MODEL_ID, mem: memSnapshot() })
    unloadBtn.disabled = false
  } catch (e) {
    log({ event: 'load.error', error: String(e), stack: (e as Error)?.stack })
    setLoadStatus('load failed — see log')
  } finally {
    loadBtn.disabled = false
    await renderDiag()
  }
}

async function unloadModel() {
  if (!engine) return
  unloadBtn.disabled = true
  try {
    await engine.unload()
    log({ event: 'unload.done', mem: memSnapshot() })
    setLoadStatus('unloaded (model evicted from GPU; cache still in OPFS)')
  } catch (e) {
    log({ event: 'unload.error', error: String(e) })
  }
}

async function clearCache() {
  clearBtn.disabled = true
  try {
    await deleteModelAllInfoInCache(MODEL_ID, APP_CONFIG)
    log({ event: 'cache.cleared', backend: CACHE_BACKEND })
    setLoadStatus('cache cleared')
  } catch (e) {
    log({ event: 'cache.clear.error', error: String(e) })
  } finally {
    clearBtn.disabled = false
    await renderDiag()
  }
}

function buildPrompt(op: TransformOp, text: string): { messages: ChatMessage[]; json: boolean } {
  let system: string
  let json = false
  switch (op.kind) {
    case 'cleanup':
      system =
        'You clean scanned ebook text. Fix OCR errors, strip inline page numbers/headers/footers (e.g. "Page 7", "Chapter One" when inline), repair hyphenation broken across line breaks (e.g. "glimmer-\\ning" -> "glimmering"), merge fragment lines. Output ONLY the cleaned paragraph. No commentary, no markdown.'
      break
    case 'translate':
      system = `You are a literary translator. Translate the user's text into language code "${op.target}". Preserve meaning and tone. Output ONLY the translation.`
      break
    case 'summarize':
      system = `Summarize the user's text to ~${Math.round(op.ratio * 100)}% of its length, keeping key narrative beats. Output ONLY the summary.`
      break
    case 'simplify':
      system = `Rewrite the user's text at a Grade-${op.level} reading level (simple words, short sentences). Output ONLY the rewritten text.`
      break
    case 'hints':
      system =
        'Scan the text for proper nouns, invented/fantasy/sci-fi names, and foreign phrases that a text-to-speech engine might mispronounce. Return a JSON object: {"candidates":[{"find":"original word","replace":"phonetic reshaped spelling to make TTS say it right","confidence":0.0 to 1.0}]}. Rank by confidence descending. Output ONLY the JSON object.'
      json = true
      break
  }
  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: text },
    ],
    json,
  }
}

async function runOp(op: TransformOp) {
  if (!engine) {
    log({ event: 'op.error', op: op.kind, message: 'model not loaded — click Load first' })
    setOpStatus('model not loaded')
    return
  }
  const text = ($('text') as HTMLTextAreaElement).value
  const { messages, json } = buildPrompt(op, text)
  abortBtn.disabled = false
  setOpStatus(`${op.kind}…`)
  outputEl.textContent = ''
  const t0 = performance.now()
  let tFirst: number | null = null
  let acc = ''
  let usage: { completion_tokens?: number; prompt_tokens?: number; total_tokens?: number } | null = null
  try {
    const stream = await engine.chat.completions.create({
      messages,
      temperature: 0.3,
      stream: true,
      stream_options: { include_usage: true },
      ...(json ? { response_format: { type: 'json_object' as const } } : {}),
    })
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? ''
      if (delta) {
        if (tFirst === null) {
          tFirst = performance.now() - t0
          setOpStatus(`${op.kind}… streaming (first token ${tFirst.toFixed(0)} ms)`)
        }
        acc += delta
        outputEl.textContent = acc
      }
      if (chunk.usage) usage = chunk.usage
    }
    const totalMs = performance.now() - t0
    const completionTokens = usage?.completion_tokens ?? null
    const tokensSec = completionTokens != null ? completionTokens / (totalMs / 1000) : null
    let runtimeStats = 'n/a'
    try {
      runtimeStats = await engine.runtimeStatsText()
    } catch {
      /* not all builds expose */
    }
    log({
      event: 'op.done',
      op: op.kind,
      msToFirstToken: tFirst != null ? Number(tFirst.toFixed(0)) : null,
      totalMs: Number(totalMs.toFixed(0)),
      promptTokens: usage?.prompt_tokens ?? null,
      completionTokens,
      tokensSec: tokensSec != null ? Number(tokensSec.toFixed(1)) : null,
      runtimeStats,
      outputLen: acc.length,
      mem: memSnapshot(),
    })
    setOpStatus(
      `${op.kind} done — ${totalMs.toFixed(0)} ms${
        tokensSec != null ? `, ${tokensSec.toFixed(1)} tok/s` : ''
      }${tFirst != null ? `, first token ${tFirst.toFixed(0)} ms` : ''}`,
    )
    if (json) {
      try {
        const parsed = JSON.parse(acc)
        log({ event: 'hints.parsed', candidates: parsed.candidates?.length ?? 0, data: parsed })
      } catch {
        log({ event: 'hints.parse.failed', raw: acc.slice(0, 400) })
      }
    }
  } catch (e) {
    log({ event: 'op.error', op: op.kind, error: String(e), stack: (e as Error)?.stack })
    setOpStatus(`${op.kind} failed — see log`)
  } finally {
    abortBtn.disabled = true
  }
}

function wireOps() {
  for (const btn of document.querySelectorAll<HTMLButtonElement>('button.op')) {
    btn.addEventListener('click', () => {
      const op = btn.dataset.op
      if (op === 'cleanup') void runOp({ kind: 'cleanup' })
      else if (op === 'translate')
        void runOp({ kind: 'translate', target: ($('lang') as HTMLInputElement).value || 'es' })
      else if (op === 'summarize')
        void runOp({
          kind: 'summarize',
          ratio: Number(($('ratio') as HTMLInputElement).value) || 0.5,
        })
      else if (op === 'simplify')
        void runOp({
          kind: 'simplify',
          level: Number(($('level') as HTMLInputElement).value) || 2,
        })
      else if (op === 'hints') void runOp({ kind: 'hints' })
    })
  }
}

document.addEventListener('DOMContentLoaded', () => {
  void renderDiag()
  loadBtn.addEventListener('click', () => void loadModel())
  unloadBtn.addEventListener('click', () => void unloadModel())
  clearBtn.addEventListener('click', () => void clearCache())
  abortBtn.addEventListener('click', async () => {
    if (!engine) return
    try {
      await engine.interruptGenerate()
      log({ event: 'op.interrupted' })
      setOpStatus('interrupted')
    } catch (e) {
      log({ event: 'interrupt.error', error: String(e) })
    }
  })
  wireOps()
  log({
    event: 'boot',
    modelId: MODEL_ID,
    cacheBackend: CACHE_BACKEND,
    note: 'click Load model to begin; first load downloads ~1GB to OPFS',
  })
})
