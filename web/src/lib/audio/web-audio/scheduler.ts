/**
 * Web Audio paragraph scheduler (ADR-0010 / M11).
 *
 * Pure scheduling core — no React, no DOM beyond the injected `AudioContextLike`.
 * Decoded paragraph buffers are chained via `source.start(scheduledEnd)` for
 * sample-accurate gapless playback. The advance loop runs on `setInterval`
 * (never `requestAnimationFrame` — rAF throttles to ~1 Hz when the tab is
 * hidden; `setInterval` keeps the highlight tracking and ≥3 ¶s stay scheduled
 * ahead so a throttled tick never starves playback).
 *
 * Pause = `ctx.suspend()` (freezes `currentTime`); play = `ctx.resume()`. This
 * is what makes iOS lock-suspend benign — nothing fires while locked, and the
 * schedule resumes intact on tap.
 *
 * Seek and rate change **re-anchor**: stop future sources and reschedule from
 * the target paragraph. Never mutate `playbackRate` on already-scheduled sources
 * (it desyncs the offset table).
 */

/** Minimal slice of `AudioBuffer` the scheduler reads. */
export interface AudioBufferLike {
  readonly duration: number
  readonly numberOfChannels: number
  readonly length: number
  readonly sampleRate: number
}

/** Minimal slice of `AudioBufferSourceNode` the scheduler drives. */
export interface AudioBufferSourceNodeLike {
  buffer: AudioBufferLike | null
  readonly playbackRate: { value: number }
  connect(destination: unknown): void
  disconnect(): void
  start(when?: number, offset?: number): void
  stop(when?: number): void
  onended: (() => void) | null
}

export type SchedulerAudioState = 'running' | 'suspended' | 'closed' | 'interrupted'

/** Minimal slice of `AudioContext` the scheduler needs. Real AudioContext is a supertype. */
export interface AudioContextLike {
  readonly currentTime: number
  readonly state: SchedulerAudioState
  readonly sampleRate: number
  readonly destination: unknown
  createBufferSource(): AudioBufferSourceNodeLike
  createGain(): { gain: { value: number }; connect(destination: unknown): void }
  suspend(): Promise<void>
  resume(): Promise<void>
  addEventListener(type: 'statechange', listener: () => void): void
  removeEventListener(type: 'statechange', listener: () => void): void
}

/** A paragraph the scheduler can play. `getBuffer` is lazy (decode-on-demand). */
export interface SchedulerParagraph {
  /** Stable id (matches `ParagraphRef.id`). */
  id: string
  /** Audio duration at rate 1×, in seconds. */
  duration: number
  /** Fetch + decode the AudioBuffer. Cache-hit fast; miss synthesizes. */
  getBuffer: () => Promise<AudioBufferLike>
}

export interface SchedulerCallbacks {
  /** Fires when the current paragraph changes (highlight tracking). */
  onParagraphChange?: (index: number) => void
  /** Fires once when the last scheduled paragraph ends. */
  onEnded?: () => void
  /** Fires when the AudioContext state changes (e.g. iOS `interrupted` on lock). */
  onStateChange?: (state: SchedulerAudioState) => void
}

interface ScheduledEntry {
  source: AudioBufferSourceNodeLike
  start: number
  end: number
  index: number
  buffer: AudioBufferLike
}

const DEFAULT_LOOKAHEAD = 3
const DEFAULT_ADVANCE_INTERVAL_MS = 250

/**
 * Compute cumulative start offsets from per-paragraph durations at a given rate.
 * Pure — unit-tested directly.
 */
export function computeOffsets(durations: number[], rate: number): number[] {
  const offsets = new Array<number>(durations.length)
  let acc = 0
  for (let i = 0; i < durations.length; i++) {
    const d = durations[i]
    offsets[i] = acc
    acc += (d ?? 0) / rate
  }
  return offsets
}

/**
 * Binary search: find the greatest index `i` such that `offsets[i] <= time`.
 * Returns -1 when `time` is before the first offset. Past-end detection is the
 * caller's job (compare against the total scheduled end). Pure — unit-tested.
 */
export function findParagraphIndexAt(offsets: number[], time: number): number {
  const n = offsets.length
  if (n === 0) return -1
  const first = offsets[0]
  if (first === undefined || time < first) return -1
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    const off = offsets[mid]
    if (off !== undefined && off <= time) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * Owns the AudioContext scheduling graph for a list of paragraphs. The React
 * hook (`useWebAudioPlayer`) constructs one and wires its callbacks to state.
 */
export class ParagraphScheduler {
  private paragraphs: SchedulerParagraph[] = []
  private scheduled: ScheduledEntry[] = []
  private scheduledEnd = 0
  private pointer = 0
  private rate = 1
  private currentIndex: number | null = null
  private ended = false
  private gen = 0
  private scheduling = false
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly bufferCache = new Map<string, AudioBufferLike>()
  private readonly stateListener: () => void

  constructor(
    private readonly ctx: AudioContextLike,
    private readonly callbacks: SchedulerCallbacks = {},
    private readonly opts: {
      lookahead?: number
      advanceIntervalMs?: number
      /** Override for `source.connect()` target (e.g. a GainNode routing to
       *  both `ctx.destination` + a `MediaStreamAudioDestinationNode` so a
       *  hidden `<audio>` element can claim the OS Media Session). */
      destination?: unknown
    } = {},
  ) {
    this.stateListener = () => this.callbacks.onStateChange?.(this.ctx.state)
    this.ctx.addEventListener('statechange', this.stateListener)
  }

  private get lookahead(): number {
    return Math.max(1, this.opts.lookahead ?? DEFAULT_LOOKAHEAD)
  }

  /** Replace the paragraph list. Resets the schedule + pointer. */
  setParagraphs(paragraphs: SchedulerParagraph[]): void {
    this.stop()
    this.paragraphs = paragraphs
    this.pointer = 0
    this.currentIndex = null
    this.ended = false
    this.bufferCache.clear()
  }

  /** Update playback rate; re-anchors the schedule from the current paragraph. */
  setPlaybackRate(rate: number): void {
    const clamped = Math.max(0.5, Math.min(2, rate))
    if (clamped === this.rate) return
    this.rate = clamped
    const from = this.currentIndex ?? this.pointer
    void this.scheduleFrom(from)
  }

  /** Resume the context and start scheduling from the pointer (or `fromIndex`). */
  async play(fromIndex: number = this.pointer): Promise<void> {
    await this.ctx.resume()
    await this.scheduleFrom(fromIndex)
    this.startAdvanceLoop()
  }

  async pause(): Promise<void> {
    await this.ctx.suspend()
  }

  async resume(): Promise<void> {
    await this.ctx.resume()
  }

  /** Stop everything and reset to paragraph 0. */
  stop(): void {
    this.gen++
    this.stopSources()
    this.scheduled = []
    this.scheduledEnd = this.ctx.currentTime
    this.pointer = 0
    this.currentIndex = null
    this.ended = false
    this.stopAdvanceLoop()
  }

  /** Stop + reschedule from `index`. Keeps the advance loop running. */
  async seekToParagraph(index: number): Promise<void> {
    const clamped = Math.max(0, Math.min(this.paragraphs.length - 1, index))
    await this.scheduleFrom(clamped)
    this.startAdvanceLoop()
  }

  /** Paragraph-relative position for Media Session. */
  getAudioPosition(): { currentTime: number; duration: number } {
    const entry = this.entryAt(this.ctx.currentTime)
    if (!entry) return { currentTime: 0, duration: 0 }
    return {
      currentTime: this.ctx.currentTime - entry.start,
      duration: entry.buffer.duration / this.rate,
    }
  }

  getCurrentIndex(): number | null {
    return this.currentIndex
  }

  /** Count of paragraphs scheduled ahead of the current one (lookahead window health). */
  getBufferedAhead(): number {
    const cur = this.currentIndex
    if (cur === null) return 0
    return this.scheduled.filter((e) => e.index > cur).length
  }

  /** Release all sources + listeners. Call on hook unmount. */
  dispose(): void {
    this.stop()
    this.ctx.removeEventListener('statechange', this.stateListener)
  }

  // ── internals ───────────────────────────────────────────────────────────

  private async getOrDecode(p: SchedulerParagraph): Promise<AudioBufferLike> {
    const cached = this.bufferCache.get(p.id)
    if (cached) return cached
    const buffer = await p.getBuffer()
    this.bufferCache.set(p.id, buffer)
    this.pruneBufferCache()
    return buffer
  }

  /** Keep only buffers near the pointer (lookahead window + one behind). */
  private pruneBufferCache(): void {
    const keepFrom = Math.max(0, this.pointer - 1)
    const keepTo = this.pointer + this.lookahead
    for (const id of this.bufferCache.keys()) {
      const idx = this.paragraphs.findIndex((p) => p.id === id)
      if (idx < keepFrom || idx > keepTo) this.bufferCache.delete(id)
    }
  }

  /** Stop + reschedule `lookahead` paragraphs starting at `index`. */
  private async scheduleFrom(index: number): Promise<void> {
    const myGen = ++this.gen
    this.pointer = index
    this.stopSources()
    this.scheduled = []
    this.scheduledEnd = this.ctx.currentTime
    this.ended = false
    this.scheduling = true
    try {
      const to = Math.min(index + this.lookahead, this.paragraphs.length)
      for (let i = index; i < to; i++) {
        if (myGen !== this.gen) return
        const para = this.paragraphs[i]
        if (!para) continue
        let buffer: AudioBufferLike
        try {
          buffer = await this.getOrDecode(para)
        } catch (err) {
          console.error('[taletrek] scheduler: scheduleFrom decode failed', {
            paragraphId: para.id,
            index: i,
            errName: (err as Error).name,
            errMessage: (err as Error).message,
            errConstructor: (err as object).constructor?.name,
          })
          if (myGen === this.gen) this.callbacks.onParagraphChange?.(index)
          return
        }
        if (myGen !== this.gen) return
        const start = Math.max(this.ctx.currentTime, this.scheduledEnd)
        const source = this.ctx.createBufferSource()
        source.buffer = buffer
        source.playbackRate.value = this.rate
        source.connect(this.gainDestination)
        source.start(start)
        const end = start + buffer.duration / this.rate
        this.scheduled.push({ source, start, end, index: i, buffer })
        this.scheduledEnd = end
      }
      this.onAdvance()
    } finally {
      if (myGen === this.gen) this.scheduling = false
    }
  }

  /** Keep the lookahead window full as playback advances. Idempotent + guarded. */
  private async scheduleMore(): Promise<void> {
    if (this.scheduling) return
    const lastEntry = this.scheduled.at(-1)
    const last = lastEntry ? lastEntry.index : this.pointer - 1
    const want = this.pointer + this.lookahead
    if (last >= want || last >= this.paragraphs.length - 1) return
    this.scheduling = true
    const myGen = this.gen
    try {
      let next = last + 1
      while (next <= Math.min(this.pointer + this.lookahead, this.paragraphs.length - 1)) {
        if (myGen !== this.gen) return
        const para = this.paragraphs[next]
        if (!para) break
        let buffer: AudioBufferLike
        try {
          buffer = await this.getOrDecode(para)
        } catch (err) {
          console.error('[taletrek] scheduler: scheduleMore decode failed', {
            paragraphId: para.id,
            index: next,
            errName: (err as Error).name,
            errMessage: (err as Error).message,
            errConstructor: (err as object).constructor?.name,
          })
          return
        }
        if (myGen !== this.gen) return
        const start = Math.max(this.ctx.currentTime, this.scheduledEnd)
        const source = this.ctx.createBufferSource()
        source.buffer = buffer
        source.playbackRate.value = this.rate
        source.connect(this.gainDestination)
        source.start(start)
        const end = start + buffer.duration / this.rate
        this.scheduled.push({ source, start, end, index: next, buffer })
        this.scheduledEnd = end
        next++
      }
    } finally {
      if (myGen === this.gen) this.scheduling = false
    }
  }

  private get gainDestination(): unknown {
    return this.opts.destination ?? this.ctx.destination
  }

  private entryAt(time: number): ScheduledEntry | null {
    for (const e of this.scheduled) {
      if (time >= e.start && time < e.end) return e
    }
    return null
  }

  private onAdvance = (): void => {
    const t = this.ctx.currentTime
    const entry = this.entryAt(t)
    const newIndex = entry?.index ?? null
    if (newIndex !== null && newIndex !== this.currentIndex) {
      this.currentIndex = newIndex
      this.callbacks.onParagraphChange?.(newIndex)
    }
    if (entry === null && this.scheduled.length > 0 && t >= this.scheduledEnd && !this.ended) {
      this.ended = true
      this.callbacks.onEnded?.()
    }
    void this.scheduleMore()
  }

  private startAdvanceLoop(): void {
    if (this.timer !== null) return
    const intervalMs = this.opts.advanceIntervalMs ?? DEFAULT_ADVANCE_INTERVAL_MS
    this.timer = setInterval(this.onAdvance, intervalMs)
  }

  private stopAdvanceLoop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private stopSources(): void {
    for (const e of this.scheduled) {
      try {
        e.source.onended = null
        e.source.stop()
      } catch {
        // already ended
      }
      try {
        e.source.disconnect()
      } catch {
        // noop
      }
    }
  }
}
