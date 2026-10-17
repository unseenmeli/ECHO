import { describe, expect, it } from 'vitest'
import type { BoardBatch, BoardElement } from '../src/shared/board'
import { findFreeRect, findSlotNear, layoutNodes, niceScale, overlaps, routeEdge, segmentHitsRect, sizeNode, usableView, type Rect } from '../src/main/lesson/layout'
import { VisualPlanSchema, visualPlanJsonSchema, type VisualOp, type VisualPlan } from '../src/main/lesson/ops'
import { fmt, layoutEdgeLabel, mergeBatch, skeletonBounds, translateOps } from '../src/main/lesson/translate'
import { SegmentStreamParser, containsDeictic, parseDrawing, splitSentences, stripDeictic } from '../src/main/lesson/tutorProtocol'
import type { DataSeries } from '../src/main/lesson/types'
import { describeBoardForTutor, summarizeBoard } from '../src/main/lesson/summary'
import { validatePlan } from '../src/main/lesson/validate'
import { World } from '../src/main/lesson/world'

const VIEW = { scrollX: 0, scrollY: 0, zoom: 1, width: 1400, height: 900 }
const CTX = { segmentId: 's1', data: [] as DataSeries[], newTopic: false, viewport: VIEW }

const userRect = (id: string, x: number, y: number, w = 200, h = 100, extra: Partial<BoardElement> = {}): BoardElement =>
  ({ id, type: 'rectangle', x, y, width: w, height: h, isDeleted: false, opacity: 100, ...extra }) as BoardElement

const nodeRects = (b: BoardBatch): Rect[] =>
  b.upsert
    .filter((s) => (s.customData as { echo?: { kind: string } } | undefined)?.echo?.kind === 'node')
    .map((s) => ({ x: s.x, y: s.y, w: Number(s.width), h: Number(s.height) }))

const diagram = (id: string, layout: Extract<VisualOp, { op: 'diagram' }>['layout'], n: number, labels = true): VisualOp => ({
  op: 'diagram',
  id,
  title: 'Example',
  layout,
  nodes: Array.from({ length: n }, (_, i) => ({ id: `${id}_n${i}`, label: `Part ${i + 1} name`, detail: i % 2 ? 'does something' : undefined })),
  edges: Array.from({ length: n - 1 }, (_, i) => ({ from: `${id}_n${i}`, to: `${id}_n${i + 1}`, label: labels ? 'sends data' : undefined }))
})

describe('tutor segment protocol', () => {
  const draw = '{"setup":[{"op":"diagram","id":"d","layout":"row","nodes":[{"id":"a","label":"A"},{"id":"b","label":"B"}]}],"cues":[{"sentence":1,"ops":[{"op":"highlight","targets":["b"]}]}]}'
  const block = (say: string, extra = '') => `<segment><objective>Obj</objective>${extra}<say>${say}</say></segment>`

  it('hands over a segment the moment its narration closes, even when the stream is chopped arbitrarily', () => {
    const text = block('The CPU runs instructions. It talks to memory.', `<draw>${draw}</draw>`) + block('Second step here, with more words.')
    const p = new SegmentStreamParser()
    const got: string[] = []
    for (let i = 0; i < text.length; i += 7) for (const s of p.push(text.slice(i, i + 7))) got.push(s.narration)
    expect(got).toEqual(['The CPU runs instructions. It talks to memory.', 'Second step here, with more words.'])
  })

  it('speaks as soon as </say> arrives, without waiting for </segment>', () => {
    const p = new SegmentStreamParser()
    expect(p.push('<segment><objective>x</objective><say>Hello there')).toEqual([])
    const out = p.push(' friend.</say>')
    expect(out).toHaveLength(1)
    expect(p.push('</segment><segment><say>Another longer sentence here.</say>')).toHaveLength(1)
  })

  it('parses the drawing, data and new_topic', () => {
    const p = new SegmentStreamParser()
    const [s] = p.push(
      `<segment new_topic="true"><objective>Compare</objective><data id="d1" label="Weight" unit="kg" x_label="Animal" illustrative="true" source="">
cat: 4
dog: 20
</data><draw>${draw}</draw><say>Cats are lighter.</say></segment>`
    )
    expect(s.newTopic).toBe(true)
    expect(s.drawing?.plan?.setup).toHaveLength(1)
    expect(s.drawing?.plan?.cues[0].sentence).toBe(1)
    expect(s.data[0]).toMatchObject({ id: 'd1', unit: 'kg', illustrative: true, points: [{ x: 'cat', y: 4 }, { x: 'dog', y: 20 }] })
  })

  it('accepts a fenced drawing and reports a broken one instead of throwing', () => {
    expect(parseDrawing('```json\n' + draw + '\n```')?.plan).toBeTruthy()
    expect(parseDrawing('{not json')?.error).toMatch(/valid JSON/)
    expect(parseDrawing('{"setup":[{"op":"run_js"}],"cues":[]}')?.error).toBeTruthy()
    expect(parseDrawing(null)).toBeNull()
  })

  it('still speaks an answer the model did not wrap in tags', () => {
    const p = new SegmentStreamParser()
    p.push('Just a plain answer without any markup at all.')
    const out = p.end()
    expect(out).toHaveLength(1)
    expect(out[0].narration).toBe('Just a plain answer without any markup at all.')
    expect(out[0].drawing).toBeNull()
  })

  it('splits sentences for cue boundaries', () => {
    expect(splitSentences('The CPU runs code. It reads memory! Why does that matter? Speed.')).toEqual([
      'The CPU runs code.',
      'It reads memory!',
      'Why does that matter? Speed.'
    ])
  })

  it('never lets narration point at a drawing that is not there', () => {
    expect(containsDeictic('As you can see, the CPU talks to RAM.')).toBe(true)
    expect(containsDeictic('The CPU talks to RAM.')).toBe(false)
    expect(stripDeictic('As you can see here, the CPU talks to RAM.')).toBe('The CPU talks to RAM.')
    expect(stripDeictic('This diagram shows how the CPU works.')).toBe('Covers how the CPU works.')
  })
})

describe('plan schema and validation', () => {
  const world = (els: BoardElement[] = []) => World.from(els)
  const plan = (p: Partial<VisualPlan>): VisualPlan => VisualPlanSchema.parse({ setup: [], cues: [], ...p })
  const base = { sentenceCount: 3, data: [] as DataSeries[] }

  it('generates a JSON schema for the tool from the same definition', () => {
    const s = visualPlanJsonSchema() as { properties: Record<string, unknown> }
    expect(Object.keys(s.properties)).toEqual(expect.arrayContaining(['setup', 'cues']))
    expect(JSON.stringify(s)).toContain('"diagram"')
  })

  it('rejects malformed operations', () => {
    expect(VisualPlanSchema.safeParse({ setup: [{ op: 'diagram', id: 'Bad Id', layout: 'row', nodes: [] }], cues: [] }).success).toBe(false)
    expect(VisualPlanSchema.safeParse({ setup: [{ op: 'run_js', code: 'alert(1)' }], cues: [] }).success).toBe(false)
  })

  it('accepts a sound plan', () => {
    const p = plan({ setup: [diagram('d', 'row', 3)], cues: [{ sentence: 1, ops: [{ op: 'highlight', targets: ['d_n1'] }] }] })
    expect(validatePlan(p, { world: world(), ...base })).toEqual([])
  })

  it('catches unknown ids, duplicate ids and bad sentence indexes', () => {
    const p = plan({ setup: [diagram('d', 'row', 2), diagram('d', 'row', 2)], cues: [{ sentence: 5, ops: [{ op: 'highlight', targets: ['nope'] }] }] })
    const errs = validatePlan(p, { world: world(), ...base }).join('\n')
    expect(errs).toMatch(/already used/)
    expect(errs).toMatch(/sentence 5 does not exist/)
    expect(errs).toMatch(/unknown element id "nope"/)
  })

  it('only allows charts of supplied data', () => {
    const chart: VisualOp = { op: 'chart', id: 'c', data: 'made_up', kind: 'bar' }
    const errs = validatePlan(plan({ setup: [chart] }), { world: world(), ...base })
    expect(errs.join()).toMatch(/was not supplied/)
    const data: DataSeries = { id: 'made_up', label: 'x', unit: 'u', xLabel: 'x', illustrative: false, source: null, points: [{ x: 'a', y: 1 }, { x: 'b', y: 2 }] }
    expect(validatePlan(plan({ setup: [chart] }), { world: world(), ...base, data: [data] })).toEqual([])
  })

  it("never lets the plan modify or remove the user's drawings", () => {
    const w = world([userRect('u1', 10, 10)])
    const errs = validatePlan(plan({ setup: [{ op: 'remove', ids: ['u1'] }, { op: 'update', id: 'u1', label: 'x' }] }), { world: w, ...base }).join('\n')
    expect(errs).toMatch(/remove: "u1" is not something you created/)
    expect(errs).toMatch(/update: "u1" is not an element you created/)
    // ...but highlighting a user element by its reference is allowed.
    expect(validatePlan(plan({ setup: [{ op: 'highlight', targets: ['user:u1'] }] }), { world: w, ...base })).toEqual([])
  })

  it('flags empty plans and contradictory no_visual', () => {
    expect(validatePlan(plan({}), { world: world(), ...base }).join()).toMatch(/plan is empty/)
    expect(validatePlan(plan({ no_visual: true, setup: [diagram('d', 'row', 2)] }), { world: world(), ...base }).join()).toMatch(/no_visual is true/)
  })
})

describe('layout', () => {
  const sized = (n: number) => Array.from({ length: n }, (_, i) => sizeNode({ id: `n${i}`, label: `Component ${i + 1}`, detail: i % 2 ? 'a detail line' : undefined }))
  const edges = (n: number) => Array.from({ length: n - 1 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}`, label: 'passes data to' }))

  it.each(['row', 'column', 'grid', 'cycle', 'hub', 'tree'] as const)('%s layout never overlaps nodes', (kind) => {
    for (const n of [1, 2, 3, 5, 7, 9]) {
      const laid = layoutNodes(kind, sized(n), edges(n))
      for (let i = 0; i < laid.nodes.length; i++) {
        for (let j = i + 1; j < laid.nodes.length; j++) {
          expect(overlaps(laid.nodes[i].rect, laid.nodes[j].rect, 20), `${kind} n=${n} #${i}/#${j}`).toBe(false)
        }
      }
      expect(Math.min(...laid.nodes.map((p) => p.rect.x))).toBe(0)
    }
  })

  it('leaves room for arrow labels between neighbours in a row', () => {
    const laid = layoutNodes('row', sized(3), edges(3))
    const gap = laid.nodes[1].rect.x - (laid.nodes[0].rect.x + laid.nodes[0].rect.w)
    expect(gap).toBeGreaterThan('passes data to'.length * 16 * 0.6)
  })

  it('finds free space that avoids existing content', () => {
    const view = usableView(VIEW)
    const existing: Rect[] = [{ x: view.x, y: view.y, w: 500, h: 300 }]
    const r = findFreeRect({ w: 400, h: 250 }, existing, view)
    expect(overlaps(r, existing[0], 30)).toBe(false)
  })

  it('places new nodes next to an anchor without covering anything', () => {
    const anchor = { x: 300, y: 300, w: 160, h: 70 }
    const blockers = [{ x: 520, y: 290, w: 200, h: 90 }]
    const r = findSlotNear(anchor, { w: 160, h: 70 }, 'right', blockers)
    expect(overlaps(r, anchor)).toBe(false)
    expect(overlaps(r, blockers[0], 10)).toBe(false)
  })

  it('computes readable chart scales', () => {
    expect(niceScale(87)).toMatchObject({ max: 100, step: 20 })
    expect(fmt(3.14159)).toBe('3.14')
    expect(fmt(1200)).toBe('1200')
  })
})

describe('translator', () => {
  it('draws a labelled diagram: every node and arrow label, arrows bound to their nodes, nothing off-screen or overlapping', () => {
    const { batch } = translateOps([diagram('d', 'row', 4)], [], CTX)
    const rects = nodeRects(batch)
    expect(rects).toHaveLength(4)
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) expect(overlaps(rects[i], rects[j], 20)).toBe(false)
    const view = usableView(VIEW)
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(view.x - 1)
      expect(r.x + r.w).toBeLessThanOrEqual(view.x + view.w + 1)
      expect(r.y + r.h).toBeLessThanOrEqual(view.y + view.h + 1)
    }
    const arrows = batch.upsert.filter((s) => s.type === 'arrow')
    expect(arrows).toHaveLength(3)
    const labels = batch.upsert.filter((s) => s.type === 'text' && (s.customData as { echo: { from?: string } }).echo.from)
    expect(labels.map((l) => l.text)).toEqual(['sends data', 'sends data', 'sends data'])
    expect(batch.bindings).toHaveLength(3)
    // New content lands inside the visible area, and the camera frames it.
    expect(batch.focus?.mode).toBe('frame')
    for (const r of ['echo:d_n0', 'echo:d_n3']) expect(batch.focus?.ids).toContain(r)
    // Every node is a sticker: a shadow underneath, grouped with it so they drag together.
    for (const n of ['d_n0', 'd_n1', 'd_n2', 'd_n3']) {
      const ids = batch.upsert.map((s) => s.id)
      expect(ids.indexOf(`echo:${n}__shadow`)).toBeLessThan(ids.indexOf(`echo:${n}`))
      const node = batch.upsert.find((s) => s.id === `echo:${n}`)!
      const shadow = batch.upsert.find((s) => s.id === `echo:${n}__shadow`)!
      expect(shadow.groupIds).toEqual(node.groupIds)
      expect([shadow.x - node.x, shadow.y - node.y]).toEqual([6, 6])
    }
    // Everything is tagged as lesson-owned so it can be told apart from the user's drawing.
    expect(batch.upsert.every((s) => (s.customData as { echo?: unknown }).echo)).toBe(true)
    expect(batch.upsert.every((s) => s.id.startsWith('echo:'))).toBe(true)
  })

  it("places a new diagram clear of the user's existing drawings", () => {
    const view = usableView(VIEW)
    const user = [userRect('u1', view.x + 10, view.y + 10, 420, 260), userRect('u2', view.x + 500, view.y + 20, 300, 200)]
    const { batch } = translateOps([diagram('d', 'column', 3)], user, CTX)
    const all = batch.upsert.filter((s) => s.type !== 'text' || true).map((s) => ({ x: s.x, y: s.y, w: Number(s.width ?? 10), h: Number(s.height ?? 10) }))
    for (const r of nodeRects(batch)) for (const u of user) expect(overlaps(r, { x: u.x, y: u.y, w: u.width, h: u.height }, 10)).toBe(false)
    expect(all.length).toBeGreaterThan(0)
  })

  it('extends an existing diagram without moving it', () => {
    const first = translateOps([diagram('d', 'row', 3)], [], CTX)
    let board: BoardElement[] = mergeBatch([], first.batch)
    const before = new Map(board.map((e) => [e.id, [e.x, e.y]]))
    const second = translateOps(
      [{ op: 'add', diagram: 'd', near: 'd_n1', side: 'below', nodes: [{ id: 'extra', label: 'New part' }], edges: [{ from: 'd_n1', to: 'extra', label: 'feeds' }] }],
      board,
      CTX
    )
    board = mergeBatch(board, second.batch)
    for (const [id, pos] of before) {
      const now = board.find((e) => e.id === id)!
      expect([now.x, now.y]).toEqual(pos)
    }
    const added = nodeRects(second.batch)[0]
    for (const old of nodeRects(first.batch)) expect(overlaps(added, old, 10)).toBe(false)
    expect(second.batch.bindings[0]).toMatchObject({ startId: 'echo:d_n1', endId: 'echo:extra' })
  })

  it('plots only the supplied numbers, with units and an honesty caption', () => {
    const data: DataSeries = {
      id: 'speed',
      label: 'Speed',
      unit: 'm/s',
      xLabel: 'Seconds',
      illustrative: true,
      source: null,
      points: [{ x: '0', y: 0 }, { x: '1', y: 4.9 }, { x: '2', y: 9.8 }]
    }
    const { batch } = translateOps([{ op: 'chart', id: 'c', data: 'speed', kind: 'bar', title: 'Falling' }], [], { ...CTX, data: [data] })
    const texts = batch.upsert.filter((s) => s.type === 'text').map((s) => String(s.text))
    for (const v of ['0', '4.9', '9.8']) expect(texts).toContain(v)
    expect(texts.some((t) => t.includes('m/s'))).toBe(true)
    expect(texts).toContain('Seconds')
    expect(texts.some((t) => /Illustrative data/.test(t))).toBe(true)
    const bars = batch.upsert.filter((s) => /__bar\d+$/.test(String(s.id)))
    expect(bars).toHaveLength(3)
    // Bar heights are proportional to the supplied values.
    const h = (i: number) => Number(bars[i].height)
    expect(h(2) / h(1)).toBeCloseTo(9.8 / 4.9, 1)
  })

  it('skips a chart whose data does not exist instead of inventing numbers', () => {
    const r = translateOps([{ op: 'chart', id: 'c', data: 'missing', kind: 'line' }], [], CTX)
    expect(r.batch.upsert).toHaveLength(0)
    expect(r.warnings.join()).toMatch(/no data/)
  })

  it("highlights with a ring and never changes the user's own element", () => {
    const user = [userRect('u1', 100, 200)]
    const r = translateOps([{ op: 'highlight', targets: ['user:u1'], dim_others: true }], user, CTX)
    expect(r.batch.upsert.map((s) => s.id)).toEqual(['echo:hl_user_u1__glow', 'echo:hl_user_u1'])
    expect(r.batch.patch).toEqual([])
    expect(r.batch.remove).toEqual([])
    expect(r.batch.focus).toEqual({ ids: ['u1'], mode: 'pan' }) // the camera glides to what is being talked about
  })

  it('moves the highlight (and undoes dimming) when the next one is applied', () => {
    const first = translateOps([diagram('d', 'row', 3)], [], CTX)
    let board = mergeBatch([], first.batch)
    const h1 = translateOps([{ op: 'highlight', targets: ['d_n0'], dim_others: true }], board, CTX)
    expect(h1.batch.patch.some((p) => p.changes.opacity === 35)).toBe(true)
    board = mergeBatch(board, h1.batch)
    const h2 = translateOps([{ op: 'highlight', targets: ['d_n2'] }], board, CTX)
    expect(h2.batch.remove).toContain('echo:hl_d_n0')
    expect(h2.batch.patch.filter((p) => p.changes.opacity === 100).length).toBeGreaterThan(0)
    const cleared = translateOps([{ op: 'unhighlight' }], mergeBatch(board, h2.batch), CTX)
    expect(cleared.batch.remove.length).toBeGreaterThan(0)
  })

  it('does not overwrite a label the user edited', () => {
    const first = translateOps([diagram('d', 'row', 2)], [], CTX)
    const board = mergeBatch([], first.batch).map((e) => (e.id === 'echo:d_n0' ? { ...e, text: 'My own wording' } : e))
    const r = translateOps([{ op: 'update', id: 'd_n0', label: 'Renamed by AI' }], board, CTX)
    expect(r.batch.upsert).toHaveLength(0)
    expect(r.warnings.join()).toMatch(/user edited/)
  })

  it('updates labels it owns and re-routes the arrows touching them', () => {
    const first = translateOps([diagram('d', 'row', 2, true)], [], CTX)
    const board = mergeBatch([], first.batch)
    const r = translateOps([{ op: 'update', id: 'd_n1', label: 'Renamed', color: 'green' }], board, CTX)
    expect(r.batch.upsert.some((s) => s.id === 'echo:d_n1' && (s.label as { text: string }).text.includes('Renamed'))).toBe(true)
    expect(r.batch.upsert.some((s) => s.type === 'arrow')).toBe(true)
  })

  it('removes only what the lesson created, with its arrows', () => {
    const first = translateOps([diagram('d', 'row', 3)], [], CTX)
    const board = [...mergeBatch([], first.batch), userRect('u1', 5, 5)]
    const r = translateOps([{ op: 'remove', ids: ['d_n1'] }], board, CTX)
    expect(r.batch.remove).toContain('echo:d_n1')
    expect(r.batch.remove.filter((id) => id.includes('edge')).length).toBe(4) // two arrows and their two labels
    expect(r.batch.remove).not.toContain('u1')
  })

  it('draws tables and timelines', () => {
    const t = translateOps([{ op: 'table', id: 't', title: 'Compare', columns: ['Feature', 'A', 'B'], rows: [['Speed', 'Fast', 'Slow'], ['Cost', 'High', 'Low']] }], [], CTX)
    expect(t.batch.upsert.filter((s) => /__r\d+c\d+$/.test(s.id))).toHaveLength(9)
    const tl = translateOps([{ op: 'timeline', id: 'tl', events: [{ id: 'e1', label: 'First', when: '1990' }, { id: 'e2', label: 'Second', when: '2000' }, { id: 'e3', label: 'Third' }] }], [], CTX)
    expect(tl.batch.upsert.filter((s) => s.type === 'ellipse' && !s.id.endsWith('__shadow'))).toHaveLength(3)
  })

  it('puts a new-topic diagram in a fresh region', () => {
    const first = translateOps([diagram('a', 'row', 3)], [], CTX)
    const board = mergeBatch([], first.batch)
    const second = translateOps([diagram('b', 'row', 2)], board, { ...CTX, segmentId: 's2', newTopic: true })
    const occupied = board.map((e) => ({ x: e.x, y: e.y, w: e.width, h: e.height }))
    for (const r of nodeRects(second.batch)) for (const o of occupied) expect(overlaps(r, o, 30)).toBe(false)
  })
})

describe('arrow routing and camera policy', () => {
  const polyline = (s: { x: number; y: number; points?: unknown }): Array<{ x: number; y: number }> =>
    (s.points as Array<[number, number]>).map(([px, py]) => ({ x: s.x + px, y: s.y + py }))

  it('routes an arrow around a node that is in its way instead of through it', () => {
    const op: VisualOp = {
      op: 'diagram',
      id: 'web',
      layout: 'row',
      nodes: [{ id: 'a', label: 'Browser' }, { id: 'b', label: 'DNS server', detail: 'finds the address' }, { id: 'c', label: 'Web server' }],
      edges: [{ from: 'a', to: 'b', label: 'asks' }, { from: 'a', to: 'c', label: 'requests page' }]
    }
    const { batch } = translateOps([op], [], CTX)
    const rects = new Map(batch.upsert.filter((s) => s.type === 'rectangle').map((s) => [s.id, { x: s.x, y: s.y, w: Number(s.width), h: Number(s.height) }]))
    const long = batch.upsert.find((s) => s.id === 'echo:edge:a:c')!
    const pts = polyline(long)
    expect(pts.length).toBe(3) // bent, not straight
    const middle = rects.get('echo:b')!
    for (let i = 0; i < pts.length - 1; i++) expect(segmentHitsRect(pts[i], pts[i + 1], middle, 0)).toBe(false)
    // The straight neighbour stays straight.
    expect(polyline(batch.upsert.find((s) => s.id === 'echo:edge:a:b')!)).toHaveLength(2)
  })

  it('never puts an arrow label on top of a node, and never strikes a label with its own arrow', () => {
    const { batch } = translateOps([diagram('d', 'row', 3)], [], CTX)
    const nodes = nodeRects(batch)
    const labels = batch.upsert.filter((s) => s.type === 'text' && (s.customData as { echo: { from?: string } }).echo.from)
    expect(labels.length).toBe(2)
    for (const l of labels) {
      const box = skeletonBounds(l)
      for (const n of nodes) expect(overlaps(box, n, 0)).toBe(false)
      // Above the line, not on it.
      const arrow = batch.upsert.find((s) => s.id === String(l.id).replace(/:label$/, ''))!
      const [p0, p1] = polyline(arrow)
      expect(box.y + box.h).toBeLessThanOrEqual(Math.min(p0.y, p1.y) + 1)
    }
  })

  it('keeps an edge label clear of its line and both nodes at any angle', () => {
    const a: Rect = { x: 400, y: 400, w: 170, h: 70 }
    for (let deg = 0; deg < 360; deg += 15) {
      const rad = (deg * Math.PI) / 180
      const b: Rect = { x: a.x + Math.cos(rad) * 320, y: a.y + Math.sin(rad) * 240, w: 170, h: 70 }
      const route = routeEdge(a, b, [])
      const box = layoutEdgeLabel(route, 'requests page', [a, b])
      for (let i = 0; i < route.points.length - 1; i++) expect(segmentHitsRect(route.points[i], route.points[i + 1], box, 1), `${deg}deg vs line`).toBe(false)
      expect(overlaps(box, a, 0), `${deg}deg vs a`).toBe(false)
      expect(overlaps(box, b, 0), `${deg}deg vs b`).toBe(false)
    }
  })

  it('draws opposite-direction arrows between the same two things side by side, with labels that do not collide', () => {
    const op: VisualOp = {
      op: 'diagram',
      id: 'mem',
      layout: 'row',
      nodes: [{ id: 'memory', label: 'Memory' }, { id: 'disk', label: 'Disk' }],
      edges: [{ from: 'memory', to: 'disk', label: 'saves your work' }, { from: 'disk', to: 'memory', label: 'loads programs into' }]
    }
    const { batch } = translateOps([op], [], CTX)
    const a = batch.upsert.find((x) => x.id === 'echo:edge:memory:disk')!
    const b = batch.upsert.find((x) => x.id === 'echo:edge:disk:memory')!
    expect(Math.abs(a.y - b.y)).toBeGreaterThanOrEqual(20) // separate lanes, not stacked
    const la = batch.upsert.find((x) => x.id === 'echo:edge:memory:disk:label')!
    const lb = batch.upsert.find((x) => x.id === 'echo:edge:disk:memory:label')!
    const box = (l: typeof la) => skeletonBounds(l)
    expect(overlaps(box(la), box(lb), 0)).toBe(false)
    for (const n of nodeRects(batch)) {
      expect(overlaps(box(la), n, 0)).toBe(false)
      expect(overlaps(box(lb), n, 0)).toBe(false)
    }
  })

  it('moves an existing reverse arrow into its own lane when a new arrow is added on top of it', () => {
    const first = translateOps([{ op: 'diagram', id: 'm', layout: 'row', nodes: [{ id: 'cpu', label: 'CPU' }, { id: 'ram', label: 'RAM' }], edges: [{ from: 'cpu', to: 'ram', label: 'reads' }] }], [], CTX)
    const board = mergeBatch([], first.batch)
    const r = translateOps([{ op: 'add', edges: [{ from: 'ram', to: 'cpu', label: 'returns data' }] }], board, CTX)
    const ids = r.batch.upsert.filter((x) => x.type === 'arrow').map((x) => x.id).sort()
    expect(ids).toEqual(['echo:edge:cpu:ram', 'echo:edge:ram:cpu'])
    const ys = r.batch.upsert.filter((x) => x.type === 'arrow').map((x) => x.y)
    expect(Math.abs(ys[0] - ys[1])).toBeGreaterThanOrEqual(20)
  })

  it('wraps long arrow labels instead of letting them spill across the diagram', () => {
    const { batch } = translateOps([{ op: 'diagram', id: 'd', layout: 'row', nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b', label: 'saves when you save your work' }] }], [], CTX)
    const label = batch.upsert.find((x) => String(x.id).endsWith(':label'))!
    expect(String(label.text)).toContain('\n')
    expect(String(label.text).split('\n').every((line) => line.length <= 16)).toBe(true)
  })

  it('can highlight a whole diagram by its block id', () => {
    const first = translateOps([diagram('d', 'row', 3)], [], CTX)
    const board = mergeBatch([], first.batch)
    const r = translateOps([{ op: 'highlight', targets: ['d'] }], board, CTX)
    expect(r.warnings).toEqual([])
    expect(r.batch.upsert).toHaveLength(2)
    const ring = r.batch.upsert.find((s) => s.id === 'echo:hl_d')!
    for (const n of nodeRects(first.batch)) {
      expect(ring.x).toBeLessThanOrEqual(n.x)
      expect(Number(ring.width) + ring.x).toBeGreaterThanOrEqual(n.x + n.w)
    }
  })

  it('frames what was just drawn, and glides to what is highlighted', () => {
    const drawn = translateOps([diagram('d', 'row', 3)], [], CTX)
    expect(drawn.batch.focus).toMatchObject({ mode: 'frame' })
    expect(drawn.batch.focus?.ids).toContain('echo:d_n1')
    const board = mergeBatch([], drawn.batch)
    const lit = translateOps([{ op: 'highlight', targets: ['d_n2'] }], board, CTX)
    expect(lit.batch.focus).toMatchObject({ ids: ['echo:d_n2'], mode: 'pan' })
    // ...keeping the rest of its diagram in view where it fits.
    expect(lit.batch.focus?.context).toContain('echo:d_n0')
    // Drawing and highlighting in one batch: the addition is shown (with the diagram it extends), not the highlight.
    const both = translateOps([{ op: 'add', diagram: 'd', near: 'd_n2', nodes: [{ id: 'extra', label: 'Extra' }] }, { op: 'highlight', targets: ['d_n0'] }], board, CTX)
    expect(both.batch.focus?.mode).toBe('pan')
    for (const id of ['echo:extra', 'echo:d_n0', 'echo:d_n2']) expect(both.batch.focus?.ids).toContain(id)
    expect(both.batch.focus?.ids.some((id) => id.startsWith('echo:hl_'))).toBe(false)
  })

  it('removes a node together with its shadow and its highlight', () => {
    const first = translateOps([diagram('d', 'row', 3)], [], CTX)
    let board = mergeBatch([], first.batch)
    board = mergeBatch(board, translateOps([{ op: 'highlight', targets: ['d_n1'] }], board, CTX).batch)
    const r = translateOps([{ op: 'remove', ids: ['d_n1'] }], board, CTX)
    for (const id of ['echo:d_n1', 'echo:d_n1__shadow', 'echo:hl_d_n1', 'echo:hl_d_n1__glow']) expect(r.batch.remove).toContain(id)
  })

  it('removes an edge label together with its edge', () => {
    const first = translateOps([diagram('d', 'row', 3)], [], CTX)
    const board = mergeBatch([], first.batch)
    const r = translateOps([{ op: 'remove', ids: ['d_n1'] }], board, CTX)
    expect(r.batch.remove.filter((id) => id.endsWith(':label')).length).toBe(2)
  })
})

describe('code cards', () => {
  const code: VisualOp = {
    op: 'code',
    id: 'loop_demo',
    title: 'A for loop',
    language: 'python',
    lines: ['total = 0', 'for n in range(3):', '\ttotal += n', '', 'print(total)']
  }
  const echo = (s: { customData?: unknown }) => (s.customData as { echo?: { id: string; kind: string; code?: string } } | undefined)?.echo

  it('draws one highlightable strip per line, numbered from 1, with the source on the card', () => {
    const { batch, warnings } = translateOps([code], [], CTX)
    expect(warnings).toEqual([])
    const lines = batch.upsert.filter((s) => echo(s)?.kind === 'line').map((s) => echo(s)!.id)
    expect(lines).toEqual(['loop_demo__l1', 'loop_demo__l2', 'loop_demo__l3', 'loop_demo__l4', 'loop_demo__l5'])
    const card = batch.upsert.find((s) => echo(s)?.kind === 'code')!
    expect(echo(card)!.code).toBe('total = 0\nfor n in range(3):\n    total += n\n\nprint(total)')
    // Runnable languages get an output strip; empty lines get no text element.
    expect(batch.upsert.some((s) => s.id === 'echo:loop_demo__out_text')).toBe(true)
    expect(batch.upsert.some((s) => s.id === 'echo:loop_demo__l4__text')).toBe(false)
  })

  it('has no output strip for languages the board cannot run', () => {
    const { batch } = translateOps([{ ...code, id: 'java_demo', language: 'java' } as VisualOp], [], CTX)
    expect(batch.upsert.some((s) => s.id === 'echo:java_demo__out_text')).toBe(false)
  })

  it('lights up a line inside the card instead of ringing around it', () => {
    const board = mergeBatch([], translateOps([code], [], CTX).batch)
    const { batch } = translateOps([{ op: 'highlight', targets: ['loop_demo__l3'] }], board, CTX)
    const line = board.find((e) => e.id === 'echo:loop_demo__l3')!
    const wash = batch.upsert.find((s) => echo(s)?.kind === 'ring' && s.id.endsWith('__glow'))!
    expect({ x: wash.x, y: wash.y, w: wash.width, h: wash.height }).toEqual({ x: line.x, y: line.y, w: line.width, h: line.height })
  })

  it('lets a cue in the same plan highlight a line of a new card', () => {
    const p: VisualPlan = { setup: [code], cues: [{ sentence: 1, ops: [{ op: 'highlight', targets: ['loop_demo__l2'] }] }] }
    expect(validatePlan(p, { world: World.from([]), sentenceCount: 2, data: [] })).toEqual([])
    const bad: VisualPlan = { setup: [code], cues: [{ sentence: 0, ops: [{ op: 'highlight', targets: ['loop_demo__l9'] }] }] }
    expect(validatePlan(bad, { world: World.from([]), sentenceCount: 2, data: [] }).join()).toMatch(/unknown element id "loop_demo__l9"/)
  })

  it('tells the tutor the numbered source and, once run, the real output', () => {
    let board = mergeBatch([], translateOps([code], [], CTX).batch)
    expect(describeBoardForTutor(summarizeBoard(board, VIEW), [])).toMatch(/code id=loop_demo .*python; highlight line n as loop_demo__l<n>.*2: for n in range\(3\):/)
    board = board.map((e) =>
      e.id === 'echo:loop_demo__out_text'
        ? ({ ...e, text: '3', customData: { echo: { id: 'loop_demo__out_text', kind: 'part', block: 'loop_demo', detail: 'ran' } } } as BoardElement)
        : e
    )
    expect(describeBoardForTutor(summarizeBoard(board, VIEW), [])).toMatch(/the learner ran it; output: "3"/)
  })
})
