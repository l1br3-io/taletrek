// Web Audio mobile playback spike (M11 / ADR-0010).
//
// Purpose: prove that an AudioContext can drive gapless paragraph-style playback
// on iOS/Android with the same accepted lock-screen limitation as the MSE
// <video> path (ADR-0006/0010): it suspends on lock, user taps play to resume.
//
// Each "paragraph" is a short procedural AudioBuffer (distinct pitch + click
// marker) so the gapless transition between paragraphs is AUDIBLE. The advance
// loop (setInterval, NOT rAF — rAF throttles when hidden) tracks the current
// paragraph, mimicking M3's highlighting.

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const stateEl = $<HTMLElement>('state')
const ctimeEl = $<HTMLElement>('ctime')
const idxEl = $<HTMLElement>('idx')
const totalEl = $<HTMLElement>('total')
const endEl = $<HTMLElement>('end')
const visEl = $<HTMLElement>('vis')
const barEl = $<HTMLElement>('bar')
const logEl = $<HTMLPreElement>('log')

const playBtn = $<HTMLButtonElement>('play')
const pauseBtn = $<HTMLButtonElement>('pause')
const resumeBtn = $<HTMLButtonElement>('resume')
const stopBtn = $<HTMLButtonElement>('stop')
const prevBtn = $<HTMLButtonElement>('prev')
const nextBtn = $<HTMLButtonElement>('next')
const seekBtn = $<HTMLButtonElement>('seek')
const seekNEl = $<HTMLInputElement>('seekN')
const buildBtn = $<HTMLButtonElement>('build')
const countEl = $<HTMLInputElement>('count')
const secsEl = $<HTMLInputElement>('secs')
const rateEl = $<HTMLInputElement>('rate')

let ctx: AudioContext | null = null
let gain: GainNode | null = null
let buffers: AudioBuffer[] = []
let scheduled: { source: AudioBufferSourceNode; start: number; end: number; index: number }[] = []
let scheduledEnd = 0
let rate = 1
let timer: number | null = null
let ended = false

function log(msg: string) {
  const t = new Date().toISOString().slice(11, 23)
  logEl.textContent = `[${t}] ${msg}\n${logEl.textContent ?? ''}`
  // eslint-disable-next-line no-console
  console.log(`[spike] ${msg}`)
}

function setStateBadge(state: string) {
  stateEl.textContent = state
  stateEl.className = `badge ${state}`
}

/** Build `count` procedural PCM buffers, each `secs` long, distinct pitch per ¶. */
function buildBuffers(count: number, secs: number) {
  if (!ctx) return
  buffers = []
  const sr = ctx.sampleRate
  const len = Math.round(secs * sr)
  for (let i = 0; i < count; i++) {
    const buf = ctx.createBuffer(1, len, sr)
    const data = buf.getChannelData(0)
    const freq = 180 * (i + 1) // ¶0=180Hz, ¶1=360Hz, ... so boundaries are audible
    const clickSamples = Math.round(sr * 0.03) // 30ms louder click at the start
    for (let s = 0; s < len; s++) {
      const t = s / sr
      // gentle envelope so paragraphs don't click at their own edges
      const edge = Math.min(1, s / (sr * 0.01), (len - s) / (sr * 0.01))
      let v = Math.sin(2 * Math.PI * freq * t) * 0.18 * edge
      if (s < clickSamples) v += (1 - s / clickSamples) * 0.5 // start marker
      data[s] = v
    }
    buffers.push(buf)
  }
  totalEl.textContent = String(count)
  log(`built ${count} buffers × ${secs}s @ ${sr}Hz`)
}

/** Ensure AudioContext exists and is created from a user gesture. */
function ensureCtx(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext()
    gain = ctx.createGain()
    gain.gain.value = 1
    gain.connect(ctx.destination)
    setStateBadge(ctx.state)
    ctx.addEventListener('statechange', () => {
      setStateBadge(ctx?.state ?? 'closed')
      log(`statechange → ${ctx?.state}`)
    })
    log(`AudioContext created @ ${ctx.sampleRate}Hz, state=${ctx.state}`)
    setupMediaSession()
    startAdvanceLoop()
  }
  return ctx
}

/** Stop every live source and reschedule from `index` at `when`. */
function scheduleFrom(index: number, when: number) {
  if (!ctx || !gain) return
  for (const s of scheduled) {
    try {
      s.source.onended = null
      s.source.stop()
    } catch {
      // already ended
    }
    try {
      s.source.disconnect()
    } catch {
      // noop
    }
  }
  scheduled = []
  scheduledEnd = when
  ended = false
  for (let i = index; i < buffers.length; i++) {
    const start = Math.max(ctx.currentTime, scheduledEnd)
    const src = ctx.createBufferSource()
    src.buffer = buffers[i]
    src.playbackRate.value = rate
    src.connect(gain)
    src.start(start)
    const dur = buffers[i].duration / rate
    const entry = { source: src, start, end: start + dur, index: i }
    scheduled.push(entry)
    scheduledEnd = start + dur
  }
  endEl.textContent = scheduledEnd.toFixed(2)
  log(`scheduled ${buffers.length - index} ¶s from ¶${index} @ ${when.toFixed(2)}s; ends ${scheduledEnd.toFixed(2)}s`)
}

/** Find the scheduled entry covering `time`, or null if past the end. */
function entryAt(time: number) {
  for (const e of scheduled) {
    if (time >= e.start && time < e.end) return e
  }
  return null
}

function startAdvanceLoop() {
  if (timer != null) return
  timer = window.setInterval(() => {
    if (!ctx) return
    const t = ctx.currentTime
    ctimeEl.textContent = t.toFixed(2)
    const e = entryAt(t)
    if (e) {
      idxEl.textContent = String(e.index)
      const within = (t - e.start) / (e.end - e.start)
      const overall = (e.index + within) / buffers.length
      barEl.style.width = `${Math.min(100, overall * 100)}%`
    } else if (scheduled.length > 0 && t >= scheduledEnd && !ended) {
      ended = true
      idxEl.textContent = 'done'
      barEl.style.width = '100%'
      log(`reached end of schedule at ${t.toFixed(2)}s`)
    }
  }, 100)
}

// ── Controls ────────────────────────────────────────────────────────────────

playBtn.addEventListener('click', async () => {
  const c = ensureCtx()
  await c.resume()
  if (scheduled.length === 0) {
    scheduleFrom(0, c.currentTime + 0.05)
  }
  log(`play: resume() → ${c.state}`)
})

pauseBtn.addEventListener('click', async () => {
  if (!ctx) return
  await ctx.suspend()
  log(`pause: suspend() → ${ctx.state}`)
})

resumeBtn.addEventListener('click', async () => {
  if (!ctx) return
  await ctx.resume()
  log(`resume: resume() → ${ctx.state}`)
})

stopBtn.addEventListener('click', () => {
  if (!ctx) return
  for (const s of scheduled) {
    try {
      s.source.stop()
    } catch {
      // noop
    }
  }
  scheduled = []
  scheduledEnd = ctx.currentTime
  idxEl.textContent = '—'
  barEl.style.width = '0%'
  log('stop: cleared schedule')
})

prevBtn.addEventListener('click', () => {
  if (!ctx) return
  const cur = entryAt(ctx.currentTime)
  const target = Math.max(0, (cur?.index ?? 0) - 1)
  scheduleFrom(target, ctx.currentTime + 0.02)
})

nextBtn.addEventListener('click', () => {
  if (!ctx) return
  const cur = entryAt(ctx.currentTime)
  const target = Math.min(buffers.length - 1, (cur?.index ?? -1) + 1)
  scheduleFrom(target, ctx.currentTime + 0.02)
})

seekBtn.addEventListener('click', () => {
  if (!ctx) return
  const n = Math.max(0, Math.min(buffers.length - 1, Number(seekNEl.value) || 0))
  scheduleFrom(n, ctx.currentTime + 0.02)
})

buildBtn.addEventListener('click', () => {
  const c = ensureCtx()
  const count = Math.max(1, Number(countEl.value) || 8)
  const secs = Math.max(1, Number(secsEl.value) || 6)
  for (const s of scheduled) {
    try {
      s.source.stop()
    } catch {
      // noop
    }
  }
  scheduled = []
  scheduledEnd = c.currentTime
  buildBuffers(count, secs)
})

rateEl.addEventListener('change', () => {
  rate = Math.max(0.5, Math.min(2, Number(rateEl.value) || 1))
  log(`rate → ${rate}× (re-anchoring schedule)`)
  if (!ctx) return
  const cur = entryAt(ctx.currentTime)
  const target = cur?.index ?? 0
  // Re-anchor from the current paragraph so offset bookkeeping stays consistent
  // — this is the same approach useWebAudioPlayer will take on rate change.
  scheduleFrom(target, ctx.currentTime + 0.02)
})

// ── Page lifecycle instrumentation (for checklist items 2 & 4) ───────────────

document.addEventListener('visibilitychange', () => {
  const v = document.visibilityState
  visEl.textContent = v
  log(`visibilitychange → ${v} (ctx.state=${ctx?.state})`)
})
window.addEventListener('pagehide', () => log(`pagehide (ctx.state=${ctx?.state})`))
window.addEventListener('pageshow', () => log(`pageshow (ctx.state=${ctx?.state})`))

// ── Media Session (checklist item 5) ────────────────────────────────────────

function setupMediaSession() {
  if (!('mediaSession' in navigator)) {
    log('MediaSession API not available')
    return
  }
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'TaleTrek Web Audio spike',
      artist: 'TaleTrek',
      album: '¶ 0',
    })
    navigator.mediaSession.setActionHandler('play', () => {
      ctx?.resume()
      log('mediaSession: play')
    })
    navigator.mediaSession.setActionHandler('pause', () => {
      ctx?.suspend()
      log('mediaSession: pause')
    })
    navigator.mediaSession.setActionHandler('previoustrack', () => {
      if (!ctx) return
      const cur = entryAt(ctx.currentTime)
      scheduleFrom(Math.max(0, (cur?.index ?? 0) - 1), ctx.currentTime + 0.02)
      log('mediaSession: previoustrack')
    })
    navigator.mediaSession.setActionHandler('nexttrack', () => {
      if (!ctx) return
      const cur = entryAt(ctx.currentTime)
      scheduleFrom(Math.min(buffers.length - 1, (cur?.index ?? -1) + 1), ctx.currentTime + 0.02)
      log('mediaSession: nexttrack')
    })
    log('MediaSession handlers registered')
  } catch (err) {
    log(`MediaSession setup failed: ${String(err)}`)
  }
}

// ── Boot ────────────────────────────────────────────────────────────────────

setStateBadge('—')
log('spike ready — press Play to create the AudioContext (needs a user gesture).')
log(`UA: ${navigator.userAgent}`)
log(`AudioContext available: ${typeof AudioContext !== 'undefined'}`)
