import * as tts from '@mintplex-labs/piper-tts-web'

const $ = (id: string) => document.getElementById(id)!
const log = (msg: unknown) => {
  const el = $('log') as HTMLPreElement
  const line = typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2)
  el.textContent += `${line}\n`
  console.log('[spike]', msg)
}
const setStatus = (s: string) => ($('status').textContent = s)

const DEFAULT_VOICE = 'en_US-hfc_female-medium'

function isCrossOriginIsolated(): boolean {
  return typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated
}

function memSnapshot(): string {
  const perf = performance as Performance & {
    memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number }
  }
  const m = perf.memory
  if (!m) return 'memory API unavailable'
  return `heap ${(m.usedJSHeapSize / 1024 / 1024).toFixed(1)} MiB / limit ${(m.jsHeapSizeLimit / 1024 / 1024).toFixed(0)} MiB`
}

async function init() {
  log({
    event: 'boot',
    crossOriginIsolated: isCrossOriginIsolated(),
    ua: navigator.userAgent.slice(0, 80),
  })

  // Populate voices
  try {
    const voices = (await tts.voices()) as {
      key: string
      name?: string
      language?: { code: string }
    }[]
    const select = $('voice') as HTMLSelectElement
    for (const v of voices) {
      const opt = document.createElement('option')
      opt.value = v.key
      opt.textContent = v.key
      if (v.key === DEFAULT_VOICE) opt.selected = true
      select.appendChild(opt)
    }
    const stored = (await tts.stored()) as string[]
    log({
      event: 'voices',
      count: voices.length,
      defaultExists: voices.some((v) => v.key === DEFAULT_VOICE),
      storedInOpfs: stored,
    })
  } catch (e) {
    log({ event: 'voices.error', error: String(e) })
  }

  // Media Session metadata — this is what the lock screen would show.
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'TaleTrek spike',
      artist: 'Piper TTS (on-device)',
      album: 'TaleTrek',
    })
    log({ event: 'mediaSession.set', actions: 'default controls' })
  } else {
    log({ event: 'mediaSession.unsupported' })
  }
}

async function downloadModel(voiceId: string) {
  const t0 = performance.now()
  ;($('download') as HTMLButtonElement).disabled = true
  setStatus(`downloading ${voiceId}…`)
  try {
    await tts.download(voiceId, (p: { url?: string; loaded?: number; total?: number }) => {
      if (p.total) {
        setStatus(`downloading ${voiceId}… ${Math.round(((p.loaded ?? 0) * 100) / p.total)}%`)
      }
    })
    const ms = (performance.now() - t0).toFixed(0)
    log({ event: 'download.done', voiceId, ms, memBefore: memSnapshot() })
    setStatus(`downloaded ${voiceId} in ${ms} ms`)
  } catch (e) {
    log({ event: 'download.error', error: String(e) })
    setStatus('download failed')
  } finally {
    ;($('download') as HTMLButtonElement).disabled = false
  }
}

async function synthesize() {
  const voiceId = ($('voice') as HTMLSelectElement).value
  const text = ($('text') as HTMLTextAreaElement).value
  ;($('synth') as HTMLButtonElement).disabled = true
  const memBefore = memSnapshot()
  const t0 = performance.now()
  setStatus('synthesizing…')
  try {
    const wav = (await tts.predict({ text, voiceId })) as Blob
    const synthMs = performance.now() - t0
    const url = URL.createObjectURL(wav)
    const audio = $('audio') as HTMLAudioElement
    audio.src = url
    // Wait for duration to be readable.
    await new Promise<void>((res) => {
      audio.onloadedmetadata = () => res()
      setTimeout(res, 2000)
    })
    const dur = audio.duration
    const rt = dur > 0 ? synthMs / 1000 / dur : null
    log({
      event: 'synth.done',
      voiceId,
      textLen: text.length,
      bytes: wav.size,
      synthMs: synthMs.toFixed(0),
      audioDurationSec: isFinite(dur) ? dur.toFixed(2) : null,
      realtimeFactor: rt ? rt.toFixed(2) : null,
      memAfter: memSnapshot(),
      memBefore,
    })
    setStatus(
      `synth ${synthMs.toFixed(0)} ms → ${isFinite(dur) ? dur.toFixed(2) + ' s audio' : '?'}${
        rt ? ` (${rt.toFixed(2)}× realtime)` : ''
      }`,
    )
  } catch (e) {
    log({ event: 'synth.error', error: String(e) })
    setStatus('synth failed')
  } finally {
    ;($('synth') as HTMLButtonElement).disabled = false
  }
}

document.addEventListener('DOMContentLoaded', () => {
  void init()
  ;($('download') as HTMLButtonElement).addEventListener('click', () => {
    void downloadModel(($('voice') as HTMLSelectElement).value)
  })
  ;($('synth') as HTMLButtonElement).addEventListener('click', () => {
    void synthesize()
  })
})
