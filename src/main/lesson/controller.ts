import type { BatchResult, BoardBatch, BoardElement, BoardViewport } from '../../shared/board'
import type { ChatMessage } from '../voice/history'
import type { VisualOp, VisualPlan } from './ops'
import { mergeBatch, translateOps } from './translate'
import { stripDeictic, toTeachingSegment, type Drawing, type ParsedSegment } from './tutorProtocol'
import type { LessonStatus, SegmentMetrics, TeachingSegment } from './types'
import { validatePlan } from './validate'
import { World } from './world'

// The lesson controller is the authority on timing. The tutor writes each segment's drawing and narration in
// one stream; the controller checks the drawing against the live board, draws the essentials, then releases
// the narration sentence by sentence to TTS. Visual cues are bound to the audio segments (flushes) those
// sentences land in and fire when the engine reports that segment actually started playing.

export interface LessonBoardPort {
  getScene(): Promise<{ elements: BoardElement[]; viewport: BoardViewport }>
  getSelected(): Promise<BoardElement[]>
  applyBatch(batch: BoardBatch): Promise<BatchResult>
}

export interface TurnIO {
  /** Aborted on interruption or session end. */
  signal: AbortSignal
  alive(): boolean
  /** Queue a sentence for speech. Returns the audio segment index when it was flushed (forced on the last sentence). */
  speakSentence(text: string, force: boolean): number | null
  /** Everything has been spoken: let the response complete. */
  finishSpeaking(): void
  status(s: LessonStatus): void
  metrics(m: SegmentMetrics): void
  log(msg: string): void
  now(): number
}

/** Compact description of a plan, kept as the lesson's memory of what has been drawn. */
export function describePlan(plan: VisualPlan): string {
  const one = (op: VisualOp): string => {
    switch (op.op) {
      case 'diagram':
        return `diagram ${op.id}(${op.nodes.map((n) => n.id).join(',')})`
      case 'add':
        return `add ${(op.nodes ?? []).map((n) => n.id).join(',') || 'edges'}`
      case 'code':
        return `code ${op.id}(${op.language}, ${op.lines.length} lines)`
      case 'chart':
      case 'table':
      case 'timeline':
      case 'note':
      case 'group':
      case 'update':
      case 'move':
        return `${op.op} ${op.id}`
      case 'highlight':
        return `highlight ${op.targets.join(',')}`
      case 'remove':
        return `remove ${op.ids.join(',')}`
      case 'focus':
        return 'focus'
      case 'unhighlight':
        return 'unhighlight'
    }
  }
  return [...plan.setup.map(one), ...plan.cues.map((c) => `@${c.sentence}: ${c.ops.map(one).join('+')}`)].join('; ').slice(0, 300) || 'nothing'
}

/** What persists across replies within one conversation. */
export class LessonState {
  readonly id = 'lesson1'
  private seq = 0
  presented: Array<{ id: string; objective: string; sentences: string[]; heard: number; complete: boolean }> = []
  visualHistory: Array<{ segment: string; objective: string; ops: string }> = []
  interruptedAt: { segmentId: string; sentence: number } | null = null

  nextSegmentId(): string {
    return `s${++this.seq}`
  }

  /** Short text for the tutor: what has been presented and where the user cut in. */
  describeForTutor(): string {
    if (!this.presented.length) return ''
    const recent = this.presented.slice(-4)
    const lines = recent.map((s) => `- ${s.id}: ${s.objective || s.sentences[0]?.slice(0, 80) || ''}${s.complete ? '' : ` (heard ${s.heard} of ${s.sentences.length} sentences)`}`)
    const cut = this.interruptedAt
    return [`Segments already presented:`, ...lines, cut ? `The user interrupted during ${cut.segmentId} before sentence ${cut.sentence + 1}.` : ''].filter(Boolean).join('\n')
  }
}

type Prep = 'pending' | 'ready' | 'none' | 'failed'

interface Seg {
  seg: TeachingSegment
  drawing: Drawing | null
  readyAt: number
  prep: Prep
  plan: VisualPlan | null
  prepDoneAt: number | null
  released: boolean
  setupApplied: boolean
  appliedCues: Set<number>
  /** Flush index per sentence (the audio segment that sentence is part of). */
  sentenceFlush: Array<number | null>
  startedFlushes: Set<number>
  lastFlush: number | null
  metrics: SegmentMetrics
  verbal: boolean
}

export interface LessonTurnDeps {
  io: TurnIO
  board: LessonBoardPort | null
  lesson: LessonState
  question: string
  dialogue: ChatMessage[]
}

const PREP_TIMEOUT_MS = 3000

export class LessonTurn {
  private segs: Seg[] = []
  private nextRelease = 0
  private tutorDone = false
  private cancelled = false
  private finished = false
  private releasing = false
  private boardChain: Promise<unknown> = Promise.resolve()
  private prepChain: Promise<unknown> = Promise.resolve()
  private flushOwner = new Map<number, Seg>()
  private flushCues = new Map<number, Array<{ seg: Seg; sentence: number; cueIndex: number; ops: VisualOp[] }>>()
  private warnClearTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: LessonTurnDeps) {
    deps.io.signal.addEventListener('abort', () => this.cancel(), { once: true })
  }

  private get io(): TurnIO {
    return this.deps.io
  }

  private alive(): boolean {
    return !this.cancelled && this.io.alive()
  }

  // --- Input from the tutor stream -------------------------------------------------------------

  onTutorSegment(parsed: ParsedSegment): void {
    if (!this.alive()) return
    const seg = toTeachingSegment(parsed, this.deps.lesson.nextSegmentId(), this.segs.length)
    const hasDrawing = !!parsed.drawing && !!this.deps.board
    const s: Seg = {
      seg,
      drawing: parsed.drawing,
      readyAt: this.io.now(),
      prep: hasDrawing ? 'pending' : 'none',
      plan: null,
      prepDoneAt: null,
      released: false,
      setupApplied: false,
      appliedCues: new Set(),
      sentenceFlush: seg.sentences.map(() => null),
      startedFlushes: new Set(),
      lastFlush: null,
      verbal: false,
      metrics: { segmentId: seg.id, mode: hasDrawing ? 'visual' : this.deps.board ? 'no-visual-needed' : 'verbal-only' }
    }
    this.segs.push(s)
    this.io.log(`[lesson] ${seg.id} ready (${seg.sentences.length} sentence${seg.sentences.length === 1 ? '' : 's'}, drawing=${hasDrawing})`)
    // Drawings are checked in order, so each sees the board as earlier segments will leave it.
    if (hasDrawing) this.prepChain = this.prepChain.then(() => this.prepare(s, this.segs.indexOf(s)))
    this.pump()
  }

  onTutorDone(): void {
    this.tutorDone = true
    this.pump()
  }

  // --- Checking the drawing against the live board -------------------------------------------------

  private async prepare(s: Seg, index: number): Promise<void> {
    if (!this.alive()) return
    try {
      if (s.drawing?.error) throw new Error(s.drawing.error)
      const board = this.deps.board!
      const scene = await Promise.race([board.getScene(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('whiteboard did not answer')), PREP_TIMEOUT_MS))])
      if (!this.alive()) return

      // The board as it WILL look once earlier segments' remaining drawing has been applied.
      let elements = scene.elements
      for (let i = this.nextRelease; i < index; i++) {
        const prev = this.segs[i]
        if (!prev.plan) continue
        const ops: VisualOp[] = []
        if (!prev.setupApplied) ops.push(...prev.plan.setup)
        for (const [ci, c] of prev.plan.cues.entries()) if (!prev.appliedCues.has(ci)) ops.push(...c.ops)
        if (ops.length) elements = mergeBatch(elements, translateOps(ops, elements, { segmentId: prev.seg.id, data: prev.seg.data, newTopic: prev.seg.newTopic, viewport: scene.viewport }).batch)
      }
      const world = World.from(elements)
      const check = (plan: VisualPlan): string[] => validatePlan(plan, { world, sentenceCount: s.seg.sentences.length, data: s.seg.data })
      let plan = s.drawing!.plan!
      let problems = check(plan)
      if (problems.length && plan.cues.length) {
        // Keep the essential drawing if only the timed extras are wrong.
        const trimmed = { ...plan, cues: [] }
        if (!check(trimmed).length) {
          this.io.log(`[lesson] ${s.seg.id} dropped invalid cues: ${problems.slice(0, 2).join('; ')}`)
          plan = trimmed
          problems = []
        }
      }
      if (problems.length) throw new Error(problems.slice(0, 2).join('; '))
      s.plan = plan
      s.prep = plan.no_visual ? 'none' : 'ready'
    } catch (err) {
      if (!this.alive()) return
      s.prep = 'failed'
      this.io.log(`[lesson] ${s.seg.id} drawing unusable: ${err instanceof Error ? err.message : err}`)
    }
    s.prepDoneAt = this.io.now()
    s.metrics.prepMs = s.prepDoneAt - s.readyAt
    this.pump()
  }

  // --- Scheduling ----------------------------------------------------------------------------------

  private pump(): void {
    if (this.alive()) void this.tryRelease()
  }

  /** Has the previous segment's last audio started (so the next one may begin to be sent)? */
  private gateOpen(): boolean {
    if (this.nextRelease === 0) return true
    const prev = this.segs[this.nextRelease - 1]
    return prev.lastFlush !== null && prev.startedFlushes.has(prev.lastFlush)
  }

  private async tryRelease(): Promise<void> {
    if (this.releasing || !this.alive()) return
    if (this.nextRelease >= this.segs.length) {
      this.maybeFinish()
      return
    }
    const s = this.segs[this.nextRelease]
    if (!this.gateOpen() || s.prep === 'pending') return
    this.releasing = true
    try {
      await this.release(s)
    } finally {
      this.releasing = false
    }
    if (this.alive()) this.pump()
  }

  // --- Releasing a segment: draw the essentials, then speak ------------------------------------

  private async release(s: Seg): Promise<void> {
    let applied = false
    if (s.prep === 'ready' && s.plan) {
      try {
        const t0 = this.io.now()
        await this.applyOps(s, s.plan.setup, 'setup')
        s.setupApplied = true
        applied = true
        s.metrics.setupAppliedMs = this.io.now() - s.readyAt
        this.deps.lesson.visualHistory.push({ segment: s.seg.id, objective: s.seg.objective, ops: describePlan(s.plan) })
        this.deps.lesson.visualHistory = this.deps.lesson.visualHistory.slice(-6)
        this.io.log(`[lesson] ${s.seg.id} setup applied in ${this.io.now() - t0}ms`)
      } catch (err) {
        s.prep = 'failed'
        this.io.log(`[lesson] ${s.seg.id} drawing failed: ${err instanceof Error ? err.message : err}`)
      }
    }
    if (!this.alive()) return

    s.verbal = !applied
    if (s.prep === 'failed' && s.drawing && this.deps.board) {
      this.io.status({ level: 'warn', message: "Couldn't draw this part, so I'll explain it in words." })
      if (this.warnClearTimer) clearTimeout(this.warnClearTimer)
      this.warnClearTimer = setTimeout(() => this.io.status({ level: 'info', message: null }), 7000)
    }
    s.metrics.mode = applied ? 'visual' : this.deps.board && s.prep !== 'failed' ? 'no-visual-needed' : 'verbal-only'

    // Narration that refers to a drawing must not be spoken when the drawing isn't there.
    const sentences = s.verbal ? s.seg.sentences.map(stripDeictic).filter(Boolean) : s.seg.sentences
    const cuesBySentence = new Map<number, Array<{ cueIndex: number; ops: VisualOp[] }>>()
    if (applied) s.plan!.cues.forEach((c, cueIndex) => cuesBySentence.set(c.sentence, [...(cuesBySentence.get(c.sentence) ?? []), { cueIndex, ops: c.ops }]))

    s.released = true
    const lastIndex = sentences.length - 1
    let pending: number[] = []
    sentences.forEach((text, k) => {
      pending.push(k)
      const idx = this.io.speakSentence(text, k === lastIndex)
      if (idx !== null) {
        for (const p of pending) s.sentenceFlush[p] = idx
        this.flushOwner.set(idx, s)
        s.lastFlush = idx
        const cues = pending.flatMap((p) => (cuesBySentence.get(p) ?? []).map((c) => ({ seg: s, sentence: p, cueIndex: c.cueIndex, ops: c.ops })))
        if (cues.length) this.flushCues.set(idx, cues)
        pending = []
      }
    })
    s.metrics.ttsSentMs = this.io.now() - s.readyAt
    this.nextRelease += 1
    this.deps.lesson.presented.push({ id: s.seg.id, objective: s.seg.objective, sentences: s.seg.sentences, heard: 0, complete: false })
  }

  // --- Playback events (the timing reference) ------------------------------------------------------

  /** The engine reports that audio segment `flushIndex` has actually begun playing. */
  onSegmentStart(flushIndex: number, atMs: number): void {
    if (!this.alive()) return
    const s = this.flushOwner.get(flushIndex)
    if (!s) return
    s.startedFlushes.add(flushIndex)
    if (s.metrics.audioStartMs === undefined) {
      s.metrics.audioStartMs = atMs - s.readyAt
      this.io.log(`[lesson] ${s.seg.id} audio started ${s.metrics.audioStartMs}ms after the segment was ready`)
    }
    const heard = s.sentenceFlush.filter((f) => f !== null && s.startedFlushes.has(f)).length
    const rec = this.deps.lesson.presented.find((p) => p.id === s.seg.id)
    if (rec) {
      rec.heard = heard
      rec.complete = s.lastFlush !== null && s.startedFlushes.has(s.lastFlush)
    }
    const cues = this.flushCues.get(flushIndex)
    if (cues?.length) {
      this.flushCues.delete(flushIndex)
      for (const c of cues) {
        void this.applyOps(s, c.ops, `cue@${c.sentence}`).then(
          () => {
            const delay = this.io.now() - atMs
            ;(s.metrics.cueDelaysMs ??= []).push(delay)
            s.appliedCues.add(c.cueIndex)
            this.io.log(`[lesson] ${s.seg.id} cue@${c.sentence} applied ${delay}ms after its audio started`)
          },
          (err) => this.io.log(`[lesson] ${s.seg.id} cue@${c.sentence} failed: ${err instanceof Error ? err.message : err}`)
        )
      }
    }
    if (s.lastFlush === flushIndex) {
      // Report once the cues for this segment have actually been applied, so their delays are included.
      const report = (): void => this.io.metrics(s.metrics)
      void this.boardChain.then(report, report)
      this.pump() // the next segment may now be sent
    }
  }

  // --- Drawing ----------------------------------------------------------------------------------------------

  /** Reads the board fresh, translates and applies one atomic batch. Serialized. */
  private applyOps(s: Seg, ops: VisualOp[], label: string, afterCompletion = false): Promise<void> {
    const ok = (): boolean => (afterCompletion ? !this.cancelled : this.alive())
    const run = async (): Promise<void> => {
      if (!ok() || !ops.length) return
      const board = this.deps.board
      if (!board) throw new Error('No whiteboard is open')
      const scene = await board.getScene() // fresh: the user may have edited since the drawing was checked
      if (!ok()) return
      const { batch, warnings } = translateOps(ops, scene.elements, { segmentId: s.seg.id, data: s.seg.data, newTopic: s.seg.newTopic, viewport: scene.viewport })
      for (const w of warnings) this.io.log(`[lesson] ${s.seg.id} ${label}: ${w}`)
      if (!batch.upsert.length && !batch.patch.length && !batch.remove.length && !batch.focus) return
      await board.applyBatch(batch)
    }
    const next = this.boardChain.then(run, run)
    this.boardChain = next.catch(() => undefined)
    return next
  }

  // --- Completion and cancellation ---------------------------------------------------------------------------------

  private maybeFinish(): void {
    if (this.finished || !this.tutorDone || this.nextRelease < this.segs.length || this.releasing) return
    this.finished = true
    this.io.finishSpeaking()
  }

  /** The explanation finished playing: remove rings and dimming so the board is left clean. */
  onComplete(): void {
    if (this.cancelled || !this.deps.board) return
    const last = [...this.segs].reverse().find((s) => s.setupApplied)
    if (!last) return
    void this.applyOps(last, [{ op: 'unhighlight' }], 'cleanup', true).catch(() => undefined)
  }

  /** Interruption or session end: stop everything; what is already drawn stays. */
  cancel(): void {
    if (this.cancelled) return
    this.cancelled = true
    if (this.warnClearTimer) clearTimeout(this.warnClearTimer)
    this.flushCues.clear()
    // Remember where the user cut in, so "continue" resumes without repeating.
    const started = this.segs.filter((s) => s.startedFlushes.size > 0)
    const cur = started[started.length - 1]
    if (cur) {
      const lastStarted = Math.max(...cur.startedFlushes)
      const sentence = Math.max(0, cur.sentenceFlush.findIndex((f) => f === lastStarted))
      this.deps.lesson.interruptedAt = cur.lastFlush !== null && cur.startedFlushes.has(cur.lastFlush) ? null : { segmentId: cur.seg.id, sentence }
    }
    // Segments that never began were not presented.
    const heardIds = new Set(started.map((s) => s.seg.id))
    this.deps.lesson.presented = this.deps.lesson.presented.filter((p) => heardIds.has(p.id) || !this.segs.some((s) => s.seg.id === p.id))
  }

  /** For tests and diagnostics. */
  snapshot(): { released: number; total: number; prep: Prep[] } {
    return { released: this.nextRelease, total: this.segs.length, prep: this.segs.map((s) => s.prep) }
  }
}
