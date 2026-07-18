import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type AudioBufferLike,
  type AudioContextLike,
  computeOffsets,
  findParagraphIndexAt,
  ParagraphScheduler,
  type SchedulerAudioState,
  type SchedulerParagraph,
} from './scheduler'

// ── Fakes ──────────────────────────────────────────────────────────────────

class FakeBuffer implements AudioBufferLike {
  constructor(
    readonly duration: number,
    readonly sampleRate = 48000,
  ) {}
  readonly numberOfChannels = 1
  get length() {
    return Math.round(this.duration * this.sampleRate)
  }
}

class FakeSource {
  buffer: AudioBufferLike | null = null
  readonly playbackRate = { value: 1 }
  onended: (() => void) | null = null
  connect = vi.fn((_: unknown) => {})
  disconnect = vi.fn(() => {})
  start = vi.fn((when = 0, _offset?: number) => {
    this.startedAt = when
  })
  stop = vi.fn((_when?: number) => {})
  startedAt: number | undefined
}

class FakeCtx implements AudioContextLike {
  currentTime = 0
  state: SchedulerAudioState = 'running'
  readonly sampleRate = 48000
  readonly destination = {}
  readonly sources: FakeSource[] = []
  createBufferSource() {
    const s = new FakeSource()
    this.sources.push(s)
    return s
  }
  createGain() {
    return { gain: { value: 1 }, connect: vi.fn((_: unknown) => {}) }
  }
  suspend = vi.fn(async () => {
    this.state = 'suspended'
  })
  resume = vi.fn(async () => {
    this.state = 'running'
  })
  private readonly listeners: Record<string, Array<() => void>> = {}
  addEventListener(type: string, l: () => void) {
    if (!this.listeners[type]) this.listeners[type] = []
    this.listeners[type].push(l)
  }
  removeEventListener(type: string, l: () => void) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((x) => x !== l)
  }
  emitStateChange() {
    for (const l of this.listeners.statechange ?? []) l()
  }
}

function makeParagraphs(count: number, durEach = 5): SchedulerParagraph[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `p${i}`,
    duration: durEach,
    getBuffer: vi.fn(async () => new FakeBuffer(durEach)),
  }))
}

// ── Pure helpers ───────────────────────────────────────────────────────────

describe('computeOffsets', () => {
  it('accumulates cumulative start times scaled by rate', () => {
    expect(computeOffsets([5, 5, 5], 1)).toEqual([0, 5, 10])
    expect(computeOffsets([4, 6, 2], 1)).toEqual([0, 4, 10])
    expect(computeOffsets([5, 5, 5], 2)).toEqual([0, 2.5, 5])
  })

  it('handles empty input', () => {
    expect(computeOffsets([], 1)).toEqual([])
  })
})

describe('findParagraphIndexAt', () => {
  const offsets = [0, 5, 10, 15]
  it('locates the active paragraph', () => {
    expect(findParagraphIndexAt(offsets, 0)).toBe(0)
    expect(findParagraphIndexAt(offsets, 4.99)).toBe(0)
    expect(findParagraphIndexAt(offsets, 5)).toBe(1)
    expect(findParagraphIndexAt(offsets, 12)).toBe(2)
    expect(findParagraphIndexAt(offsets, 15)).toBe(3)
  })
  it('returns -1 before the first offset or for empty input', () => {
    expect(findParagraphIndexAt(offsets, -1)).toBe(-1)
    expect(findParagraphIndexAt([], 5)).toBe(-1)
  })
})

// ── ParagraphScheduler ─────────────────────────────────────────────────────

describe('ParagraphScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('schedules the lookahead window gaplessly (start times chain exactly)', async () => {
    const ctx = new FakeCtx()
    const s = new ParagraphScheduler(ctx, {}, { lookahead: 3 })
    s.setParagraphs(makeParagraphs(5, 5))
    await s.play(0)

    const starts = ctx.sources.map((src) => src.startedAt)
    expect(starts).toEqual([0, 5, 10]) // p0, p1, p2 — sample-accurate gapless
    expect(ctx.sources[0]?.playbackRate.value).toBe(1)
  })

  it('fires onParagraphChange as currentTime advances', async () => {
    const ctx = new FakeCtx()
    const changes: number[] = []
    const s = new ParagraphScheduler(ctx, { onParagraphChange: (i) => changes.push(i) })
    s.setParagraphs(makeParagraphs(4, 5))
    await s.play(0)

    ctx.currentTime = 6 // mid p1
    await vi.advanceTimersByTimeAsync(250)
    ctx.currentTime = 11 // mid p2
    await vi.advanceTimersByTimeAsync(250)

    expect(changes).toContain(1)
    expect(changes).toContain(2)
    expect(s.getCurrentIndex()).toBe(2)
  })

  it('keeps the lookahead window full as playback advances (scheduleMore)', async () => {
    const ctx = new FakeCtx()
    const s = new ParagraphScheduler(ctx, {}, { lookahead: 2 })
    const paras = makeParagraphs(6, 5)
    s.setParagraphs(paras)
    await s.play(0)

    // Initially: p0, p1 scheduled
    expect(ctx.sources.map((src) => src.startedAt)).toEqual([0, 5])

    ctx.currentTime = 5 // entering p1; pointer should advance, triggering scheduleMore for p2
    await vi.advanceTimersByTimeAsync(250)
    await vi.advanceTimersByTimeAsync(250) // second tick to let async scheduleMore settle

    // p2 should now be scheduled too (window of 2 ahead of pointer)
    expect(ctx.sources.length).toBeGreaterThanOrEqual(3)
  })

  it('seek stops existing sources and reschedules from the target', async () => {
    const ctx = new FakeCtx()
    const s = new ParagraphScheduler(ctx, {}, { lookahead: 3 })
    s.setParagraphs(makeParagraphs(8, 5))
    await s.play(0)
    expect(ctx.sources.length).toBe(3) // p0,p1,p2

    const firstRun = ctx.sources.slice()
    await s.seekToParagraph(5)

    // Old sources stopped, new sources scheduled from p5
    for (const src of firstRun) {
      expect(src.stop).toHaveBeenCalled()
    }
    expect(s.getCurrentIndex()).toBe(5)
    // New sources are p5, p6, p7 (lookahead 3, clamped to length 8)
    expect(ctx.sources.length).toBe(3 + 3) // original 3 still in the array (recorded), +3 new
  })

  it('rate change re-anchors the schedule', async () => {
    const ctx = new FakeCtx()
    const s = new ParagraphScheduler(ctx, {}, { lookahead: 3 })
    s.setParagraphs(makeParagraphs(5, 4))
    await s.play(0)
    expect(ctx.sources.map((src) => src.startedAt)).toEqual([0, 4, 8])

    // Move into p1, then change rate — should reschedule from p1 with new spacing
    ctx.currentTime = 5
    await vi.advanceTimersByTimeAsync(250)
    const idxBefore = s.getCurrentIndex()
    expect(idxBefore).toBe(1)

    s.setPlaybackRate(2)
    await vi.advanceTimersByTimeAsync(500) // finite tick — let the reschedule settle

    // Every currently-scheduled source must reflect the new rate
    for (const src of ctx.sources.slice(ctx.sources.length - 3)) {
      expect(src.playbackRate.value).toBe(2)
    }
  })

  it('pause suspends the context (freeze parity with iOS lock)', async () => {
    const ctx = new FakeCtx()
    const s = new ParagraphScheduler(ctx)
    s.setParagraphs(makeParagraphs(3, 5))
    await s.play(0)

    await s.pause()
    expect(ctx.suspend).toHaveBeenCalledTimes(1)
    expect(ctx.state).toBe('suspended')
  })

  it('resume resumes the context', async () => {
    const ctx = new FakeCtx()
    const s = new ParagraphScheduler(ctx)
    s.setParagraphs(makeParagraphs(3, 5))
    await s.play(0)
    await s.pause()
    await s.resume()
    expect(ctx.resume).toHaveBeenCalled()
    expect(ctx.state).toBe('running')
  })

  it('fires onEnded when currentTime passes the last scheduled end', async () => {
    const ctx = new FakeCtx()
    let ended = false
    const s = new ParagraphScheduler(ctx, { onEnded: () => (ended = true) }, { lookahead: 3 })
    s.setParagraphs(makeParagraphs(2, 5))
    await s.play(0)

    ctx.currentTime = 11 // past the end (p0+p1 = 10s)
    await vi.advanceTimersByTimeAsync(250)
    expect(ended).toBe(true)
  })

  it('stop halts all sources and resets the pointer', async () => {
    const ctx = new FakeCtx()
    const s = new ParagraphScheduler(ctx, {}, { lookahead: 3 })
    s.setParagraphs(makeParagraphs(5, 5))
    await s.play(0)
    expect(ctx.sources.length).toBe(3)

    s.stop()
    for (const src of ctx.sources) expect(src.stop).toHaveBeenCalled()
    expect(s.getCurrentIndex()).toBeNull()
  })

  it('forwards statechange events (iOS interrupted on lock)', async () => {
    const ctx = new FakeCtx()
    const states: SchedulerAudioState[] = []
    const s = new ParagraphScheduler(ctx, { onStateChange: (st) => states.push(st) })
    s.setParagraphs(makeParagraphs(2, 5))
    await s.play(0)

    ctx.state = 'interrupted'
    ctx.emitStateChange()
    expect(states).toContain('interrupted')
  })

  it('getAudioPosition returns paragraph-relative time', async () => {
    const ctx = new FakeCtx()
    const s = new ParagraphScheduler(ctx, {}, { lookahead: 3 })
    s.setParagraphs(makeParagraphs(3, 5))
    await s.play(0)

    ctx.currentTime = 6.5 // 1.5s into p1
    await vi.advanceTimersByTimeAsync(250)
    const pos = s.getAudioPosition()
    expect(pos.duration).toBeCloseTo(5, 1)
    expect(pos.currentTime).toBeCloseTo(1.5, 1)
  })
})
