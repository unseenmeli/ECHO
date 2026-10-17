import { describe, expect, it } from 'vitest'
import type { BoardElement } from '../src/shared/board'
import { diagramPlan, seg, setup, sleep, until } from './helpers/lesson-fakes'

describe('lesson controller: speech and drawing stay in step', () => {
  it('draws the essentials first, then speaks; cues fire only when their audio actually starts', async () => {
    const t = setup()
    t.turn.onTutorSegment(seg('The CPU does the work. It reads from memory. Memory loads from disk.', diagramPlan('d1', [{ sentence: 1, ops: [{ op: 'highlight', targets: ['d1_b'] }] }, { sentence: 2, ops: [{ op: 'highlight', targets: ['d1_c'] }] }])))
    t.turn.onTutorSegment(seg('That is the whole loop.', { setup: [], cues: [{ sentence: 0, ops: [{ op: 'highlight', targets: ['d1_a'] }] }] }))
    t.turn.onTutorDone()

    await until(() => t.spoken.length === 3)
    // The diagram is on the board BEFORE the first sentence goes to speech.
    expect(t.log.findIndex((l) => l.startsWith('apply:'))).toBeLessThan(t.log.indexOf('speak:0'))
    expect(t.board.batches).toHaveLength(1)
    expect(t.spoken).toHaveLength(3) // segment 2 is held while segment 1 is still playing

    t.turn.onSegmentStart(0, Date.now())
    await sleep(30)
    expect(t.board.batches).toHaveLength(1) // sentence 0 has no cue
    t.turn.onSegmentStart(1, Date.now())
    await until(() => t.board.batches.length === 2)
    expect(t.board.batches[1].upsert.map((s) => s.id)).toEqual(['echo:hl_d1_b']) // exactly the cued highlight
    expect(t.spoken).toHaveLength(3)

    t.turn.onSegmentStart(2, Date.now()) // last sentence of segment 1 begins -> the next segment may go
    await until(() => t.spoken.length === 4)
    expect(t.board.batches.some((b) => b.upsert[0]?.id === 'echo:hl_d1_c')).toBe(true)
    expect(t.finished()).toBe(1)
  })

  it('a cue never runs ahead of the voice', async () => {
    const t = setup()
    t.turn.onTutorSegment(seg('One idea here. Another idea there. A third idea last.', diagramPlan('d1', [{ sentence: 2, ops: [{ op: 'highlight', targets: ['d1_c'] }] }])))
    t.turn.onTutorDone()
    await until(() => t.spoken.length === 3)
    t.turn.onSegmentStart(0, Date.now())
    t.turn.onSegmentStart(1, Date.now())
    await sleep(50)
    expect(t.board.batches).toHaveLength(1)
    t.turn.onSegmentStart(2, Date.now())
    await until(() => t.board.batches.length === 2)
  })

  it('checks each drawing against the board as earlier segments will leave it', async () => {
    const t = setup()
    t.board.applyDelayMs = 120 // segment 1 is still being applied while segment 2 is checked
    t.turn.onTutorSegment(seg('First part of the story.', diagramPlan('d1')))
    t.turn.onTutorSegment(seg('Second part of the story.', { setup: [], cues: [{ sentence: 0, ops: [{ op: 'highlight', targets: ['d1_c'] }] }] }))
    t.turn.onTutorDone()
    await until(() => t.spoken.length === 1)
    await sleep(60)
    expect(t.turn.snapshot().prep).toEqual(['ready', 'ready']) // the reference to d1_c was accepted
  })

  it('starts speaking right away: no waiting on anything but the (fast) board check', async () => {
    const t = setup()
    const t0 = Date.now()
    t.turn.onTutorSegment(seg('Straight to the point, no delay at all.', diagramPlan('d1')))
    await until(() => t.spoken.length === 1)
    expect(Date.now() - t0).toBeLessThan(300)
  })
})

describe('lesson controller: degrading gracefully', () => {
  it('speaks without the drawing when it is unusable, never claiming one exists, and says so', async () => {
    const t = setup()
    t.turn.onTutorSegment(seg('As you can see here, the CPU talks to memory. Memory talks to the disk.', { error: 'the drawing was not valid JSON' }))
    t.turn.onTutorSegment(seg('Next the memory holds the data.', diagramPlan('d2')))
    t.turn.onTutorDone()
    await until(() => t.spoken.length === 2)
    expect(t.spoken[0].text).toBe('The CPU talks to memory.')
    expect(t.statuses.some((s) => s.level === 'warn' && /words/.test(s.message ?? ''))).toBe(true)
    expect(t.board.batches).toHaveLength(0)
    t.turn.onSegmentStart(1, Date.now())
    await until(() => t.spoken.length === 3)
    expect(t.board.batches).toHaveLength(1) // the next segment is drawn normally
  })

  it('keeps the essential drawing when only the timed cues are wrong', async () => {
    const t = setup()
    t.turn.onTutorSegment(seg('The CPU runs programs. Memory holds the data.', diagramPlan('d1', [{ sentence: 1, ops: [{ op: 'highlight', targets: ['nonexistent'] }] }])))
    t.turn.onTutorDone()
    await until(() => t.spoken.length === 2)
    expect(t.board.batches).toHaveLength(1)
    t.turn.onSegmentStart(1, Date.now())
    await sleep(40)
    expect(t.board.batches).toHaveLength(1) // the bad cue was dropped, nothing broke
  })

  it('rejects a drawing that references things that do not exist, instead of drawing nonsense', async () => {
    const t = setup()
    t.turn.onTutorSegment(seg('Something about a thing.', { setup: [], cues: [{ sentence: 0, ops: [{ op: 'highlight', targets: ['ghost'] }] }] }))
    t.turn.onTutorDone()
    await until(() => t.spoken.length === 1)
    expect(t.board.batches).toHaveLength(0)
    expect(t.turn.snapshot().prep).toEqual(['failed'])
  })

  it('continues verbally when the board refuses the drawing', async () => {
    const t = setup()
    t.board.failApply = true
    t.turn.onTutorSegment(seg('The CPU runs programs. As you can see, memory holds data.', diagramPlan('d1')))
    t.turn.onTutorDone()
    await until(() => t.spoken.length === 2)
    expect(t.spoken.every((s) => !/as you can see/i.test(s.text))).toBe(true)
  })

  it('is purely verbal when no whiteboard is open', async () => {
    const t = setup({ board: false })
    t.turn.onTutorSegment(seg('Plain explanation without any picture. It still works fine.', diagramPlan('d1')))
    t.turn.onTutorDone()
    await until(() => t.spoken.length === 2)
    expect(t.statuses).toEqual([])
    expect(t.finished()).toBe(1)
  })

  it('needs no drawing for segments that do not have one', async () => {
    const t = setup()
    t.turn.onTutorSegment(seg('Hello, nice to meet you.'))
    t.turn.onTutorDone()
    await until(() => t.spoken.length === 1)
    expect(t.board.batches).toHaveLength(0)
    expect(t.statuses).toEqual([])
  })
})

describe('lesson controller: interruption and stale work', () => {
  it('stops drawing and speaking on interruption; stale playback events do nothing; what is drawn stays', async () => {
    const t = setup()
    t.turn.onTutorSegment(seg('The CPU runs programs. Memory holds the data.', diagramPlan('d1', [{ sentence: 1, ops: [{ op: 'highlight', targets: ['d1_b'] }] }])))
    t.turn.onTutorSegment(seg('Next comes the disk and storage.', diagramPlan('d2')))
    t.turn.onTutorDone()
    await until(() => t.spoken.length === 2)
    t.turn.onSegmentStart(0, Date.now())
    const applied = t.board.batches.length
    const shown = t.board.elements.length

    t.abort.abort() // the user interrupted
    t.turn.onSegmentStart(1, Date.now()) // stale: must do nothing
    await sleep(80)
    expect(t.board.batches).toHaveLength(applied)
    expect(t.board.elements).toHaveLength(shown)
    expect(t.spoken).toHaveLength(2)
    expect(t.finished()).toBe(0)
    expect(t.lesson.interruptedAt).toMatchObject({ segmentId: 's1', sentence: 0 })
    expect(t.lesson.describeForTutor()).toMatch(/interrupted during s1/)
  })

  it("leaves the user's drawings untouched and reads the board fresh before every change", async () => {
    const t = setup()
    t.board.elements = [{ id: 'user1', type: 'rectangle', x: 50, y: 150, width: 300, height: 200, isDeleted: false, opacity: 100 } as BoardElement]
    t.turn.onTutorSegment(seg('Look at your sketch first. It matches the CPU part.', diagramPlan('d1', [{ sentence: 1, ops: [{ op: 'highlight', targets: ['user:user1'] }] }])))
    t.turn.onTutorDone()
    await until(() => t.spoken.length === 2)
    t.board.elements = t.board.elements.map((e) => (e.id === 'user1' ? { ...e, x: 700, y: 400 } : e)) // the user drags it
    t.turn.onSegmentStart(1, Date.now())
    await until(() => t.board.batches.length === 2)
    const user = t.board.elements.find((e) => e.id === 'user1')!
    expect([user.x, user.y]).toEqual([700, 400])
    expect(t.board.batches[1].upsert[0].x).toBeCloseTo(700 - 8) // the ring follows where they moved it
    expect(t.board.batches.flatMap((b) => b.remove)).not.toContain('user1')
  })

  it('reports timing metrics for each segment', async () => {
    const t = setup()
    t.turn.onTutorSegment(seg('First sentence is here. Second sentence follows.', diagramPlan('d1', [{ sentence: 1, ops: [{ op: 'highlight', targets: ['d1_b'] }] }])))
    t.turn.onTutorDone()
    await until(() => t.spoken.length === 2)
    t.turn.onSegmentStart(0, Date.now())
    t.turn.onSegmentStart(1, Date.now())
    await until(() => (t.metrics[0]?.cueDelaysMs?.length ?? 0) === 1)
    const m = t.metrics[0]
    expect(m.mode).toBe('visual')
    expect(m.prepMs).toBeGreaterThanOrEqual(0)
    expect(m.setupAppliedMs).toBeGreaterThanOrEqual(0)
    expect(m.audioStartMs).toBeGreaterThanOrEqual(0)
    expect(m.cueDelaysMs![0]).toBeLessThan(100)
  })
})
