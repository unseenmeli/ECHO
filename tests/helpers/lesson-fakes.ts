import type { BatchResult, BoardBatch, BoardElement, BoardViewport } from '../../src/shared/board'
import { LessonState, LessonTurn, type LessonBoardPort, type TurnIO } from '../../src/main/lesson/controller'
import type { VisualPlan } from '../../src/main/lesson/ops'
import { mergeBatch } from '../../src/main/lesson/translate'
import type { ParsedSegment } from '../../src/main/lesson/tutorProtocol'
import type { LessonStatus, SegmentMetrics } from '../../src/main/lesson/types'

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
export const until = async (fn: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition')
    await sleep(5)
  }
}

/** An in-memory whiteboard that applies batches the way the real one does (minus Excalidraw). */
export class FakeBoard implements LessonBoardPort {
  elements: BoardElement[] = []
  viewport: BoardViewport = { scrollX: 0, scrollY: 0, zoom: 1, width: 1400, height: 900 }
  selected: BoardElement[] = []
  batches: BoardBatch[] = []
  sceneReads = 0
  applyDelayMs = 0
  failApply = false
  constructor(private readonly log: string[]) {}
  async getScene() {
    this.sceneReads++
    return { elements: this.elements.map((e) => ({ ...e })), viewport: this.viewport }
  }
  async getSelected() {
    return this.selected
  }
  async applyBatch(batch: BoardBatch): Promise<BatchResult> {
    if (this.applyDelayMs) await sleep(this.applyDelayMs)
    if (this.failApply) throw new Error('board unavailable')
    this.batches.push(batch)
    this.elements = mergeBatch(this.elements, batch)
    this.log.push(`apply:${batch.upsert.length}up/${batch.patch.length}patch/${batch.remove.length}rm`)
    return { upserted: [], patched: [], removed: [] }
  }
}

export function setup(opts: { board?: boolean } = {}) {
  const log: string[] = []
  const board = new FakeBoard(log)
  const abort = new AbortController()
  let alive = true
  let flush = 0
  const spoken: Array<{ text: string; idx: number | null }> = []
  const statuses: LessonStatus[] = []
  const metrics: SegmentMetrics[] = []
  let finished = 0
  const io: TurnIO = {
    signal: abort.signal,
    alive: () => alive && !abort.signal.aborted,
    speakSentence: (text) => {
      const idx = flush++
      spoken.push({ text, idx })
      log.push(`speak:${idx}`)
      return idx
    },
    finishSpeaking: () => {
      finished++
      log.push('finish')
    },
    status: (s) => statuses.push(s),
    metrics: (m) => metrics.push(m),
    log: () => {},
    now: () => Date.now()
  }
  const lesson = new LessonState()
  const turn = new LessonTurn({ io, board: opts.board === false ? null : board, lesson, question: 'How does a computer work?', dialogue: [] })
  return { turn, board, abort, spoken, statuses, metrics, log, lesson, finished: () => finished, kill: () => (alive = false) }
}

/** A segment as the tutor would deliver it: narration plus an optional drawing. */
export const seg = (say: string, plan?: VisualPlan | { error: string }, extra: Partial<ParsedSegment> = {}): ParsedSegment => ({
  objective: 'Understand',
  narration: say,
  data: [],
  drawing: plan ? ('error' in plan ? { error: plan.error } : { plan }) : null,
  newTopic: false,
  ...extra
})

export const diagramPlan = (id: string, cues: VisualPlan['cues'] = []): VisualPlan => ({
  setup: [
    {
      op: 'diagram',
      id,
      title: 'Computer',
      layout: 'row',
      nodes: [
        { id: `${id}_a`, label: 'CPU' },
        { id: `${id}_b`, label: 'Memory' },
        { id: `${id}_c`, label: 'Disk' }
      ],
      edges: [
        { from: `${id}_a`, to: `${id}_b`, label: 'reads' },
        { from: `${id}_b`, to: `${id}_c`, label: 'loads from' }
      ]
    }
  ],
  cues
})
