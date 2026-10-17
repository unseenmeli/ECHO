import { TTS_SAMPLE_RATE, type EnginePlaybackReport } from '../../../../shared/voice'

const START_LEAD_S = 0.05 // small cushion before the first chunk so network jitter doesn't glitch
const FADE_S = 0.012 // quick fade on stop to avoid a click
const DUCK_GAIN = 0.15
const DUCK_FAILSAFE_MS = 2500
const POLL_MS = 20

interface Marker {
  responseId: string
  segment: number
  at: number
}

/**
 * Gapless playback of streamed PCM16. Each chunk is scheduled right after the
 * previous one. Every chunk carries a response id; once a response has been
 * cleared, anything still arriving for it is ignored, so a cancelled answer
 * can never be heard.
 */
export class Playback {
  private readonly ctx = new AudioContext({ sampleRate: TTS_SAMPLE_RATE, latencyHint: 'interactive' })
  private readonly gain = this.ctx.createGain()
  private readonly sources = new Set<AudioBufferSourceNode>()
  private readonly dead = new Set<string>()
  private markers: Marker[] = []
  /** Flush segments whose first audio is scheduled but has not started playing yet. */
  private pendingStarts: Array<{ segment: number; at: number }> = []
  private markersSeen = 0
  private scheduledSegment = -1
  /** Audio-clock span of every flush segment of the current response, for measuring how much was heard. */
  private bounds: Array<{ segment: number; start: number; end: number }> = []
  private currentId: string | null = null
  private nextTime = 0
  private firstStart: number | null = null
  private startedReported = false
  private doneId: string | null = null
  private carry: number | null = null
  private duckTimer: ReturnType<typeof setTimeout> | null = null
  private readonly timer: ReturnType<typeof setInterval>

  constructor(private readonly report: (r: EnginePlaybackReport) => void) {
    this.gain.connect(this.ctx.destination)
    this.timer = setInterval(() => this.poll(), POLL_MS)
  }

  isPlaying(): boolean {
    return this.currentId !== null && this.nextTime > this.ctx.currentTime
  }

  enqueue(responseId: string, bytes: Uint8Array): void {
    if (this.dead.has(responseId)) return
    if (this.currentId !== responseId) this.beginResponse(responseId)

    // Frames from the network can split a 16-bit sample; carry the stray byte over.
    let data = bytes
    if (this.carry !== null) {
      const merged = new Uint8Array(bytes.length + 1)
      merged[0] = this.carry
      merged.set(bytes, 1)
      data = merged
      this.carry = null
    }
    if (data.length % 2 === 1) {
      this.carry = data[data.length - 1]
      data = data.subarray(0, data.length - 1)
    }
    const samples = data.length / 2
    if (samples === 0) return

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    const buffer = this.ctx.createBuffer(1, samples, TTS_SAMPLE_RATE)
    const out = buffer.getChannelData(0)
    for (let i = 0; i < samples; i++) out[i] = view.getInt16(i * 2, true) / 32768

    const src = this.ctx.createBufferSource()
    src.buffer = buffer
    src.connect(this.gain)
    const now = this.ctx.currentTime
    const startAt = this.nextTime > now ? this.nextTime : now + (this.firstStart === null ? START_LEAD_S : 0.005)
    if (this.firstStart === null) this.firstStart = startAt
    src.start(startAt)
    // Audio that arrives after marker k belongs to flush segment k+1: remember when it will really start.
    if (this.markersSeen !== this.scheduledSegment) {
      this.scheduledSegment = this.markersSeen
      this.pendingStarts.push({ segment: this.markersSeen, at: startAt })
    }
    this.nextTime = startAt + buffer.duration
    this.sources.add(src)
    src.onended = () => this.sources.delete(src)
    if (this.ctx.state === 'suspended') void this.ctx.resume()
  }

  /** A flush boundary: reported once everything before it has actually been played. */
  marker(responseId: string, segment: number): void {
    if (this.dead.has(responseId) || this.currentId !== responseId) return
    this.markersSeen += 1
    const end = Math.max(this.nextTime, this.ctx.currentTime)
    const start = this.bounds.length ? this.bounds[this.bounds.length - 1].end : (this.firstStart ?? end)
    this.bounds.push({ segment, start, end })
    this.markers.push({ responseId, segment, at: end })
  }

  /** No more audio is coming for this response. */
  done(responseId: string): void {
    if (this.dead.has(responseId) || this.currentId !== responseId) return
    this.doneId = responseId
  }

  duck(on: boolean): void {
    if (this.duckTimer) clearTimeout(this.duckTimer)
    this.duckTimer = null
    this.gain.gain.cancelScheduledValues(this.ctx.currentTime)
    this.gain.gain.setTargetAtTime(on ? DUCK_GAIN : 1, this.ctx.currentTime, 0.012)
    // If the main process never confirms, don't stay quiet forever.
    if (on) this.duckTimer = setTimeout(() => this.duck(false), DUCK_FAILSAFE_MS)
  }

  /** Silence playback now and ignore anything further for this response. */
  clear(responseId: string): void {
    this.dead.add(responseId)
    if (this.dead.size > 50) this.dead.delete(this.dead.values().next().value as string)
    if (this.duckTimer) clearTimeout(this.duckTimer)
    this.duckTimer = null

    const now = this.ctx.currentTime
    this.gain.gain.cancelScheduledValues(now)
    this.gain.gain.setValueAtTime(this.gain.gain.value, now)
    this.gain.gain.linearRampToValueAtTime(0, now + FADE_S)

    // How far into the segment being played did the listener get? (Unknown if its end hasn't arrived yet.)
    let partial: { segment: number; fraction: number } | undefined
    if (this.currentId === responseId) {
      const b = this.bounds.find((x) => now >= x.start && now < x.end)
      if (b && b.end > b.start) partial = { segment: b.segment, fraction: (now - b.start) / (b.end - b.start) }
    }

    this.markers = this.markers.filter((m) => m.responseId !== responseId)
    if (this.currentId === responseId) this.pendingStarts = [] // paused: no further cues for this response
    if (this.currentId === responseId) this.resetResponse()

    setTimeout(
      () => {
        for (const s of this.sources) {
          try {
            s.stop()
          } catch {
            // already stopped
          }
          s.disconnect()
        }
        this.sources.clear()
        this.gain.gain.cancelScheduledValues(this.ctx.currentTime)
        this.gain.gain.setValueAtTime(1, this.ctx.currentTime)
        this.report({ kind: 'stopped', responseId, at: Date.now(), partial })
      },
      FADE_S * 1000 + 3
    )
  }

  close(): void {
    clearInterval(this.timer)
    if (this.duckTimer) clearTimeout(this.duckTimer)
    for (const s of this.sources) {
      try {
        s.stop()
      } catch {
        // ignore
      }
    }
    this.sources.clear()
    void this.ctx.close().catch(() => {})
  }

  private beginResponse(id: string): void {
    this.currentId = id
    this.nextTime = 0
    this.firstStart = null
    this.startedReported = false
    this.doneId = null
    this.carry = null
    this.markers = []
    this.bounds = []
    this.pendingStarts = []
    this.markersSeen = 0
    this.scheduledSegment = -1
  }

  private resetResponse(): void {
    this.bounds = []
    this.pendingStarts = []
    this.markersSeen = 0
    this.scheduledSegment = -1
    this.currentId = null
    this.nextTime = 0
    this.firstStart = null
    this.startedReported = false
    this.doneId = null
    this.carry = null
  }

  private poll(): void {
    const id = this.currentId
    if (!id) return
    const t = this.ctx.currentTime

    if (!this.startedReported && this.firstStart !== null && t >= this.firstStart) {
      this.startedReported = true
      this.report({ kind: 'started', responseId: id, at: Date.now() })
    }

    while (this.pendingStarts.length && t >= this.pendingStarts[0].at) {
      const p = this.pendingStarts.shift()!
      this.report({ kind: 'segmentStart', responseId: id, segment: p.segment, at: Date.now() })
    }

    while (this.markers.length && t >= this.markers[0].at) {
      const m = this.markers.shift()!
      this.report({ kind: 'segment', responseId: m.responseId, segment: m.segment, at: Date.now() })
    }

    if (this.doneId === id && !this.markers.length && t >= this.nextTime) {
      this.report({ kind: 'ended', responseId: id, at: Date.now() })
      this.resetResponse()
    }
  }
}
