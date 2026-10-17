import type { BoardBatch, BoardElement, ElementSkeleton } from '../../shared/board'
import {
  FONT,
  routeEdge,
  type Route,
  findFreeRect,
  findSlotNear,
  layoutNodes,
  measure,
  niceScale,
  overlaps,
  sizeNode,
  union,
  usableView,
  wrapText,
  type Rect,
  type SizedNode
} from './layout'
import type { EdgeSpecT, NodeSpecT, VisualOp } from './ops'
import type { DataSeries } from './types'
import { USER_REF, World, eid, type EchoMeta } from './world'

// Turns semantic visual operations into Excalidraw element skeletons, laid out
// and styled consistently. It never executes anything model-generated: ops
// are data, validated first, and everything drawn is produced here.

// House style, matching ECHO's character and app: ink outlines, pastel "sticker" fills with a hard offset
// shadow in a deeper shade, chunky display titles over a pink highlighter swipe, and hot pink for focus.
const INK = '#1c1c1e'
const MUTED = '#6b6963'
const ACCENT = '#ff2e9a'
const ACCENT_DEEP = '#c41f74'
const GRID = '#e4e1da'
const HIGHLIGHTER = '#ffd1e8'
export const PALETTE = {
  neutral: { stroke: INK, fill: '#ffffff', shade: '#dcd8cf' },
  pink: { stroke: INK, fill: '#ffe0ef', shade: '#ff8cc6' },
  blue: { stroke: INK, fill: '#dff0ff', shade: '#8cc4f5' },
  green: { stroke: INK, fill: '#dcf7e6', shade: '#7fd7a2' },
  orange: { stroke: INK, fill: '#ffeacc', shade: '#ffbd6b' },
  red: { stroke: INK, fill: '#ffe1e1', shade: '#ff9393' },
  purple: { stroke: INK, fill: '#ece3ff', shade: '#b89cff' }
} as const
type ColorName = keyof typeof PALETTE
const DIM_OPACITY = 35
const FONT_FAMILY = 6 // Nunito: clean and legible at diagram sizes
const DISPLAY_FAMILY = 7 // Lilita One: chunky and friendly, for titles
/** Offset of the hard shadow behind stickers (nodes, notes, tables, bars). */
const SHADOW = { x: 6, y: 6 }

export interface TranslateContext {
  segmentId: string
  data: DataSeries[]
  /** The segment moved to an unrelated topic: put the first new block in a fresh region. */
  newTopic: boolean
  viewport: { scrollX: number; scrollY: number; zoom: number; width?: number; height?: number }
}

export interface TranslateResult {
  batch: BoardBatch
  /** Excalidraw ids of the block most recently created (used for default camera focus). */
  focusIds: string[]
  warnings: string[]
}

const colorOf = (c: string | undefined): (typeof PALETTE)[ColorName] => PALETTE[(c as ColorName) in PALETTE ? (c as ColorName) : 'neutral']
const sk = (o: Record<string, unknown> & { id: string; type: string; x: number; y: number }): ElementSkeleton => o as ElementSkeleton

export function fmt(n: number): string {
  if (Number.isInteger(n)) return String(n)
  const s = Math.abs(n) >= 100 ? n.toFixed(0) : Math.abs(n) >= 10 ? n.toFixed(1) : n.toPrecision(3)
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s
}

class Draft {
  readonly batch: BoardBatch = { upsert: [], patch: [], remove: [], bindings: [] }
  focusIds: string[] = []
  /** How the camera should treat focusIds: frame newly drawn content, or just glide to what is being discussed. */
  focusMode: 'frame' | 'pan' = 'frame'
  /** Something was drawn in this batch: that wins the camera over a highlight. */
  focusDrawn = false
  /** Elements to keep in view around the focus while panning (the highlighted thing's diagram). */
  focusContext: string[] = []
  /** The focused content is bigger than the free area, so the camera should zoom out to fit it. */
  focusFit = false
  readonly warnings: string[] = []

  constructor(
    readonly world: World,
    readonly ctx: TranslateContext
  ) {}

  /** Adds a skeleton to the batch and to the working world so later operations see it. */
  put(skel: ElementSkeleton, rect: Rect, meta: EchoMeta, text?: string): void {
    const i = this.batch.upsert.findIndex((s) => s.id === skel.id)
    if (i >= 0) this.batch.upsert[i] = skel
    else this.batch.upsert.push(skel)
    const prev = this.world.elements.get(skel.id)
    this.world.add({ id: skel.id, type: skel.type, rect, echo: meta, text, containerId: null, boundIds: prev?.boundIds ?? [], opacity: 100 })
  }

  patch(id: string, changes: Record<string, unknown>): void {
    const existing = this.batch.patch.find((p) => p.id === id)
    if (existing) Object.assign(existing.changes, changes)
    else this.batch.patch.push({ id, changes })
  }

  remove(id: string): void {
    if (!this.batch.remove.includes(id)) this.batch.remove.push(id)
    this.batch.upsert = this.batch.upsert.filter((s) => s.id !== id)
    this.batch.bindings = this.batch.bindings.filter((b) => b.arrowId !== id)
    this.world.remove(id)
  }

  get usable(): Rect {
    return usableView(this.ctx.viewport)
  }

  meta(m: Omit<EchoMeta, 'seg'>): EchoMeta {
    return { ...m, seg: this.ctx.segmentId }
  }
}

// --- Shared drawing helpers ---------------------------------------------------------

function textSk(d: Draft, id: string, x: number, y: number, text: string, fontSize: number, color: string, meta: EchoMeta, align: 'left' | 'center' | 'right' = 'left', fontFamily = FONT_FAMILY): void {
  const lines = text.split('\n')
  const m = measure(lines, fontSize)
  // Excalidraw anchors aligned text at x (the centre for "center", the right edge for "right") and measures
  // the real width itself, so pass the anchor of the laid-out box rather than its left edge.
  const anchorX = align === 'center' ? x + m.w / 2 : align === 'right' ? x + m.w : x
  d.put(
    sk({ type: 'text', id, x: anchorX, y, text, fontSize, fontFamily, strokeColor: color, textAlign: align, roughness: 0, customData: { echo: meta } }),
    { x, y, w: m.w, h: m.h },
    meta,
    text
  )
}

function adjust(n: SizedNode, shape: NodeSpecT['shape']): SizedNode {
  if (shape === 'diamond') return { ...n, w: Math.round(n.w * 1.45), h: Math.round(n.h * 1.7) }
  if (shape === 'round') return { ...n, w: Math.round(n.w * 1.12), h: Math.round(n.h * 1.2) }
  return n
}

const shapeType = (shape: NodeSpecT['shape']): string => (shape === 'diamond' ? 'diamond' : shape === 'round' ? 'ellipse' : 'rectangle')
/** Sticker and shadow share a group so they move together when the learner drags them. */
const stickerGroup = (logical: string): string[] => [`echo-g:${logical}`]
const shadowId = (logical: string): string => eid(`${logical}__shadow`)

function nodeSkeleton(id: string, rect: Rect, text: string, shape: NodeSpecT['shape'], colorName: string | undefined, meta: EchoMeta, opacity = 100): ElementSkeleton {
  const c = colorOf(colorName)
  const type = shapeType(shape)
  return sk({
    type,
    id,
    x: rect.x,
    y: rect.y,
    width: rect.w,
    height: rect.h,
    strokeColor: c.stroke,
    backgroundColor: c.fill,
    fillStyle: 'solid',
    strokeWidth: 2,
    roughness: 0,
    opacity,
    roundness: type === 'rectangle' ? { type: 3 } : null,
    groupIds: stickerGroup(meta.id),
    label: { text, fontSize: FONT.node, fontFamily: FONT_FAMILY, strokeColor: INK, textAlign: 'center', verticalAlign: 'middle' },
    customData: { echo: meta }
  })
}

/** The hard offset shadow behind a sticker. Added before the sticker so it sits underneath. */
function putShadow(d: Draft, of: string, type: string, rect: Rect, shade: string, block: string | undefined, opacity = 100, angle = 0): void {
  const r = { x: rect.x + SHADOW.x, y: rect.y + SHADOW.y, w: rect.w, h: rect.h }
  const meta = d.meta({ id: `${of}__shadow`, kind: 'shadow', block, of })
  d.put(
    sk({
      type,
      id: shadowId(of),
      x: r.x,
      y: r.y,
      width: r.w,
      height: r.h,
      angle,
      strokeColor: shade,
      backgroundColor: shade,
      fillStyle: 'solid',
      strokeWidth: 2,
      roughness: 0,
      opacity,
      roundness: type === 'rectangle' ? { type: 3 } : null,
      groupIds: stickerGroup(of),
      customData: { echo: meta }
    }),
    r,
    meta
  )
}

/** A diagram node: its shadow, then the labelled shape. */
function putNode(d: Draft, rect: Rect, text: string, shape: NodeSpecT['shape'], colorName: string | undefined, meta: EchoMeta, opacity = 100): void {
  putShadow(d, meta.id, shapeType(shape), rect, colorOf(colorName).shade, meta.block, opacity)
  d.put(nodeSkeleton(eid(meta.id), rect, text, shape, colorName, meta, opacity), rect, meta, text)
}

/** Block title in the display face, over a pink highlighter swipe. */
function putTitle(d: Draft, id: string, block: string, x: number, y: number, title: string): void {
  // Lilita One is condensed: about 0.48 of the font size per glyph, against the generic 0.6 estimate.
  const m = measure([title], FONT.title)
  const textW = Math.ceil(m.w * 0.8)
  const swipe = { x: x - 6, y: y + m.h * 0.55, w: textW + 12, h: m.h * 0.4 }
  const sm = d.meta({ id: `${block}__swipe`, kind: 'part', block })
  d.put(
    sk({ type: 'rectangle', id: eid(`${block}__swipe`), x: swipe.x, y: swipe.y, width: swipe.w, height: swipe.h, strokeColor: 'transparent', backgroundColor: HIGHLIGHTER, fillStyle: 'solid', strokeWidth: 1, roughness: 0, roundness: { type: 3 }, customData: { echo: sm } }),
    swipe,
    sm
  )
  textSk(d, id, x, y, title, FONT.title, INK, d.meta({ id: block, kind: 'title', block }), 'left', DISPLAY_FAMILY)
}

/**
 * Where an arrow's label goes: just off the line, along its normal (so it works at any angle), on whichever
 * side is free of other elements. The side away from the top of the screen is tried first.
 */
export function layoutEdgeLabel(route: Route, label: string, obstacles: Rect[]): Rect {
  const m = measure(wrapText(label, 16), FONT.edge)
  const { at, dir } = route.label
  const n = { x: -dir.y, y: dir.x }
  // Distance from the line's centre to the box centre so the box's near edge clears the line by a margin.
  const base = Math.abs(n.x) * (m.w / 2) + Math.abs(n.y) * (m.h / 2) + 13
  const upperFirst = (a: Rect, b: Rect): number => (Math.abs(n.y) >= Math.abs(n.x) ? a.y - b.y : b.x - a.x)
  let fallback: Rect | null = null
  // Prefer hugging the line; if both sides are blocked (a short diagonal arrow), back off a little at a time.
  for (const extra of [0, 14, 30, 50, 76, 110, 150]) {
    const boxes = [1, -1]
      .map((sg) => {
        const c = { x: at.x + n.x * (base + extra) * sg, y: at.y + n.y * (base + extra) * sg }
        return { x: c.x - m.w / 2, y: c.y - m.h / 2, w: m.w, h: m.h }
      })
      .sort(upperFirst)
    fallback ??= boxes[0]
    const free = boxes.find((c) => !obstacles.some((o) => overlaps(c, o, 4)))
    if (free) return free
  }
  return fallback!
}

/** Lane for an edge whose reverse (B to A) also exists: a stable side-by-side offset so the pair never overlaps. */
const LANE = 16
// The offset is measured to the right-hand side of each arrow's own direction, so the two arrows of a pair end up on opposite sides.
const laneFor = (_from: string, _to: string): number => LANE

function arrowSkeleton(d: Draft, e: EdgeSpecT, from: Rect, to: Rect, block: string | undefined, preRoute?: Route, lane?: number): void {
  if (lane === undefined) {
    const reverse = d.world.elements.get(eid(`edge:${e.to}:${e.from}`))
    lane = reverse ? laneFor(e.from, e.to) : 0
    // The reverse arrow was drawn straight earlier; move it into its own lane too.
    if (reverse && !preRoute && reverse.echo?.kind === 'edge') {
      const a = d.world.elements.get(eid(e.to))
      const b = d.world.elements.get(eid(e.from))
      if (a && b) arrowSkeleton(d, { from: e.to, to: e.from, label: reverse.echo.label }, a.rect, b.rect, reverse.echo.block, undefined, laneFor(e.to, e.from))
    }
  }
  // Other elements the arrow must not run through (everything except its own two ends).
  const obstacles = [...d.world.elements.values()]
    .filter((w) => w.id !== eid(e.from) && w.id !== eid(e.to) && !(w.type === 'text' && w.containerId) && !(w.echo && (w.echo.kind === 'edge' || w.echo.kind === 'ring' || w.echo.kind === 'group' || w.echo.kind === 'shadow' || (w.echo.kind === 'part' && w.echo.from))) && w.rect.w > 0 && w.rect.h > 0)
    .map((w) => w.rect)
  const route = preRoute ?? routeEdge(from, to, obstacles, lane)
  const sx = route.points[0].x
  const sy = route.points[0].y
  const id = eid(`edge:${e.from}:${e.to}`)
  const meta = d.meta({ id: `${e.from}->${e.to}`, kind: 'edge', block, from: e.from, to: e.to, label: e.label })
  const xs = route.points.map((p) => p.x)
  const ys = route.points.map((p) => p.y)
  d.put(
    sk({
      type: 'arrow',
      id,
      x: sx,
      y: sy,
      points: route.points.map((p) => [p.x - sx, p.y - sy]),
      strokeColor: INK,
      strokeWidth: 2,
      strokeStyle: e.style === 'dashed' ? 'dashed' : 'solid',
      roughness: 0,
      roundness: null,
      startArrowhead: e.both ? 'triangle' : null,
      endArrowhead: 'triangle',
      customData: { echo: meta }
    }),
    { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) },
    meta
  )
  // The label is its own text beside the line (a label bound to the arrow would be struck through by the line
  // on this transparent canvas). It carries the edge's ends so it is re-routed and removed with it.
  const labelId = eid(`edge:${e.from}:${e.to}:label`)
  if (e.label) {
    const box = layoutEdgeLabel(route, e.label, obstacles)
    const lm: EchoMeta = d.meta({ id: `${e.from}->${e.to}#label`, kind: 'part', block, from: e.from, to: e.to })
    textSk(d, labelId, box.x, box.y, wrapText(e.label, 16).join('\n'), FONT.edge, MUTED, lm, 'center')
  } else if (d.world.elements.has(labelId)) {
    d.remove(labelId)
  }
  d.batch.bindings = d.batch.bindings.filter((b) => b.arrowId !== id)
  d.batch.bindings.push({ arrowId: id, startId: eid(e.from), endId: eid(e.to) })
}

/** Re-route every arrow touching `logical` after its node changed. */
function rerouteEdges(d: Draft, logical: string): void {
  for (const el of d.world.echoElements()) {
    const m = el.echo!
    if (m.kind !== 'edge' || (m.from !== logical && m.to !== logical)) continue
    const a = d.world.elements.get(eid(m.from!))
    const b = d.world.elements.get(eid(m.to!))
    if (!a || !b) continue
    arrowSkeleton(d, { from: m.from!, to: m.to!, label: m.label }, a.rect, b.rect, m.block)
  }
}

/**
 * Camera policy: the lesson is a guided tour. Whatever was just drawn is centred and framed; whatever the
 * narration is about (a highlight) is glided to. New content is still placed in free space, so nothing the
 * learner drew is ever covered.
 */
function focusOn(d: Draft, ids: string[]): void {
  const box = d.world.bounds(ids)
  const usable = d.usable
  d.focusIds = ids
  d.focusMode = 'frame'
  d.focusDrawn = true
  d.focusFit = !!box && (box.w > usable.w || box.h > usable.h)
}

/**
 * An addition to something already on the board (a node, note or group): bring it into view together with
 * what it belongs to, without zooming in on the small new piece.
 */
function reveal(d: Draft, ids: string[], context: string[]): void {
  d.focusIds = [...new Set([...ids, ...context])]
  d.focusMode = 'pan'
  d.focusDrawn = true
}

/** Glide to what is being talked about, unless something new was drawn in this batch (that is shown instead). */
function panTo(d: Draft, ids: string[], context: string[] = []): void {
  if (d.focusDrawn) return
  d.focusIds = ids
  d.focusMode = 'pan'
  d.focusContext = context
}

function blockIds(d: Draft, block: string): string[] {
  return d.world.blockMembers(block).map((e) => e.id)
}

// --- Operations ----------------------------------------------------------------------------

function diagramOp(d: Draft, op: Extract<VisualOp, { op: 'diagram' }>): void {
  const sized = op.nodes.map((n) => adjust(sizeNode(n), n.shape))
  const edges = op.edges ?? []
  const laid = layoutNodes(op.layout, sized, edges)
  const titleH = op.title ? 48 : 0
  const titleW = op.title ? measure([op.title], FONT.title).w : 0

  // Dry run in block-relative coordinates: the real extent includes arrows that bend around nodes and their labels.
  const rel = new Map<string, Rect>()
  for (const n of op.nodes) {
    const p = laid.nodes.find((x) => x.id === n.id)!
    rel.set(n.id, { x: p.rect.x, y: p.rect.y + titleH, w: p.rect.w, h: p.rect.h })
  }
  const titleRect: Rect | null = op.title ? { x: 0, y: 0, w: titleW, h: FONT.title * 1.3 } : null
  const routes = new Map<EdgeSpecT, Route>()
  const extent: Rect[] = [...rel.values(), ...(titleRect ? [titleRect] : [])]
  const laneOf = (e: EdgeSpecT): number => (edges.some((o) => o.from === e.to && o.to === e.from) ? laneFor(e.from, e.to) : 0)
  for (const e of edges) {
    const others = [...rel.entries()].filter(([id]) => id !== e.from && id !== e.to).map(([, r]) => r)
    const route = routeEdge(rel.get(e.from)!, rel.get(e.to)!, [...others, ...(titleRect ? [titleRect] : [])], laneOf(e))
    routes.set(e, route)
    for (const p of route.points) extent.push({ x: p.x, y: p.y, w: 0, h: 0 })
    if (e.label) extent.push(layoutEdgeLabel(route, e.label, [...rel.values(), ...(titleRect ? [titleRect] : [])]))
  }
  const box = union(extent)!
  const size = { w: box.w, h: box.h }
  const fresh = !!op.new_region || (d.ctx.newTopic && d.batch.upsert.length === 0 && !d.world.echoElements().some((e) => e.echo!.seg === d.ctx.segmentId))
  const at = findFreeRect(size, d.world.obstacles(), d.usable, { fresh })
  const dx = at.x - box.x
  const dy = at.y - box.y
  const shift = (r: Rect): Rect => ({ x: r.x + dx, y: r.y + dy, w: r.w, h: r.h })
  const ids: string[] = []

  if (op.title) {
    putTitle(d, eid(`${op.id}:title`), op.id, dx, dy, op.title)
    ids.push(eid(`${op.id}:title`))
  }
  const rects = new Map<string, Rect>()
  for (const n of op.nodes) {
    const rect = shift(rel.get(n.id)!)
    rects.set(n.id, rect)
    const text = sized.find((s) => s.id === n.id)!.text
    const meta = d.meta({ id: n.id, kind: 'node', block: op.id, label: n.label, detail: n.detail, color: n.color ?? 'neutral', shape: n.shape ?? 'box' })
    putNode(d, rect, text, n.shape, n.color, meta)
    ids.push(eid(n.id))
  }
  for (const e of edges) {
    const r = routes.get(e)!
    arrowSkeleton(d, e, rects.get(e.from)!, rects.get(e.to)!, op.id, { ...r, points: r.points.map((p) => ({ x: p.x + dx, y: p.y + dy })), label: { ...r.label, at: { x: r.label.at.x + dx, y: r.label.at.y + dy } } }, laneOf(e))
    ids.push(eid(`edge:${e.from}:${e.to}`))
    if (e.label) ids.push(eid(`edge:${e.from}:${e.to}:label`))
  }
  focusOn(d, ids)
}

function addOp(d: Draft, op: Extract<VisualOp, { op: 'add' }>): void {
  const anchorEl = op.near ? d.world.resolve(op.near) : undefined
  const members = op.diagram ? d.world.blockMembers(op.diagram).filter((e) => e.echo!.kind !== 'ring') : []
  const anchor: Rect | null = anchorEl?.rect ?? union(members.map((m) => m.rect)) ?? null
  const side = op.side ?? 'right'
  const ids: string[] = []
  const rects = new Map<string, Rect>()

  for (const n of op.nodes ?? []) {
    const s = adjust(sizeNode(n), n.shape)
    const rect = anchor
      ? findSlotNear(anchor, { w: s.w, h: s.h }, side, d.world.slotObstacles(), 100, d.usable)
      : findFreeRect({ w: s.w, h: s.h }, d.world.obstacles(), d.usable)
    const meta = d.meta({ id: n.id, kind: 'node', block: op.diagram, label: n.label, detail: n.detail, color: n.color ?? 'neutral', shape: n.shape ?? 'box' })
    putNode(d, rect, s.text, n.shape, n.color, meta)
    rects.set(n.id, rect)
    ids.push(eid(n.id))
  }
  for (const e of op.edges ?? []) {
    const a = rects.get(e.from) ?? d.world.elements.get(eid(e.from))?.rect
    const b = rects.get(e.to) ?? d.world.elements.get(eid(e.to))?.rect
    if (!a || !b) {
      d.warnings.push(`edge ${e.from}->${e.to} skipped: endpoint missing`)
      continue
    }
    arrowSkeleton(d, e, a, b, op.diagram)
    ids.push(eid(`edge:${e.from}:${e.to}`))
  }
  const context = op.diagram ? blockIds(d, op.diagram).filter((id) => d.world.elements.get(id)?.echo?.kind !== 'ring') : anchorEl ? [anchorEl.id] : []
  if (ids.length) reveal(d, ids, context)
}

function chartOp(d: Draft, op: Extract<VisualOp, { op: 'chart' }>): void {
  const series = d.ctx.data.find((s) => s.id === op.data)
  if (!series || !series.points.length) {
    d.warnings.push(`chart ${op.id} skipped: no data`)
    return
  }
  const pts = series.points
  const W = 580
  const left = 92
  const top = (op.title ? 48 : 0) + 34
  const plotW = W - left - 28
  const plotH = 200
  const captionH = 30
  const size = { w: W, h: top + plotH + 70 + captionH }
  const at = findFreeRect(size, d.world.obstacles(), d.usable, { fresh: !!op.new_region })
  const px = at.x + left
  const py = at.y + top
  const part = (name: string): string => `${op.id}__${name}`
  const pm = (name: string): EchoMeta => d.meta({ id: part(name), kind: 'part', block: op.id })
  const ids: string[] = []
  const note = (id: string): void => void ids.push(eid(id))

  if (op.title) {
    putTitle(d, eid(part('title')), op.id, at.x, at.y, op.title)
    note(part('title'))
  }
  // Axis titles: units are always shown, because a number without one teaches nothing.
  textSk(d, eid(part('ytitle')), at.x, at.y + (op.title ? 48 : 0), `${series.label} (${series.unit})`, FONT.small, MUTED, pm('ytitle'))
  note(part('ytitle'))

  const maxV = Math.max(...pts.map((p) => p.y), 0)
  const minV = Math.min(...pts.map((p) => p.y), 0)
  const ns = niceScale(maxV || Math.abs(minV) || 1)
  const negMax = minV < 0 ? Math.ceil(-minV / ns.step) * ns.step : 0
  const span = ns.max + negMax
  const yPix = (v: number): number => py + ((ns.max - v) / span) * plotH
  const zeroY = yPix(0)

  // Gridlines and y tick labels.
  for (let v = -negMax; v <= ns.max + 1e-9; v += ns.step) {
    const y = yPix(v)
    const gid = part(`grid${Math.round(v * 1000)}`)
    d.put(sk({ type: 'line', id: eid(gid), x: px, y, points: [[0, 0], [plotW, 0]], strokeColor: GRID, strokeWidth: 1, strokeStyle: 'dashed', roughness: 0, customData: { echo: pm(gid) } }), { x: px, y, w: plotW, h: 0 }, pm(gid))
    note(gid)
    const label = fmt(Math.round(v * 1e6) / 1e6)
    const w = measure([label], FONT.small).w
    textSk(d, eid(`${gid}:t`), px - 12 - w, y - FONT.small * 0.65, label, FONT.small, MUTED, pm(`${gid}:t`), 'right')
    note(`${gid}:t`)
  }
  // Axes.
  d.put(sk({ type: 'line', id: eid(part('xaxis')), x: px, y: zeroY, points: [[0, 0], [plotW, 0]], strokeColor: INK, strokeWidth: 2, roughness: 0, customData: { echo: pm('xaxis') } }), { x: px, y: zeroY, w: plotW, h: 0 }, pm('xaxis'))
  d.put(sk({ type: 'line', id: eid(part('yaxis')), x: px, y: py, points: [[0, 0], [0, plotH]], strokeColor: INK, strokeWidth: 2, roughness: 0, customData: { echo: pm('yaxis') } }), { x: px, y: py, w: 0, h: plotH }, pm('yaxis'))
  note(part('xaxis'))
  note(part('yaxis'))

  const slot = plotW / pts.length
  const color = colorOf('pink')
  const centers: Array<[number, number]> = []
  pts.forEach((p, i) => {
    const cx = px + slot * (i + 0.5)
    const cy = yPix(p.y)
    centers.push([cx, cy])
    if (op.kind === 'bar') {
      const bw = Math.min(76, slot * 0.62)
      const top0 = p.y >= 0 ? cy : zeroY
      const h = Math.max(2, Math.abs(zeroY - cy))
      const id = part(`bar${i}`)
      const rect = { x: cx - bw / 2, y: top0, w: bw, h }
      putShadow(d, id, 'rectangle', { ...rect, h: Math.max(2, h - SHADOW.y) }, color.shade, op.id)
      d.put(sk({ type: 'rectangle', id: eid(id), x: rect.x, y: rect.y, width: bw, height: h, strokeColor: INK, backgroundColor: color.fill, fillStyle: 'solid', strokeWidth: 2, roughness: 0, roundness: { type: 3 }, groupIds: stickerGroup(id), customData: { echo: pm(id) } }), rect, pm(id))
      note(`${id}__shadow`)
      note(id)
    } else {
      const id = part(`dot${i}`)
      d.put(sk({ type: 'ellipse', id: eid(id), x: cx - 7, y: cy - 7, width: 14, height: 14, strokeColor: INK, backgroundColor: ACCENT, fillStyle: 'solid', strokeWidth: 2, roughness: 0, customData: { echo: pm(id) } }), { x: cx - 7, y: cy - 7, w: 14, h: 14 }, pm(id))
      note(id)
    }
    // Value label (exact supplied value) just above the mark.
    const vt = fmt(p.y)
    const vw = measure([vt], FONT.small).w
    const ly = p.y >= 0 ? cy - 24 : cy + 8
    textSk(d, eid(part(`val${i}`)), cx - vw / 2, ly, vt, FONT.small, INK, pm(`val${i}`), 'center')
    note(part(`val${i}`))
    // Category label under the axis.
    const cat = p.x.length > 14 ? p.x.slice(0, 13) + '…' : p.x
    const cw = measure([cat], FONT.small).w
    textSk(d, eid(part(`cat${i}`)), cx - cw / 2, py + plotH + 12, cat, FONT.small, INK, pm(`cat${i}`), 'center')
    note(part(`cat${i}`))
  })
  if (op.kind === 'line' && centers.length > 1) {
    const [x0, y0] = centers[0]
    d.put(sk({ type: 'line', id: eid(part('line')), x: x0, y: y0, points: centers.map(([x, y]) => [x - x0, y - y0]), strokeColor: ACCENT, strokeWidth: 3, roughness: 0, roundness: { type: 2 }, customData: { echo: pm('line') } }), union(centers.map(([x, y]) => ({ x, y, w: 0, h: 0 })))!, pm('line'))
    note(part('line'))
  }
  // X axis title and honesty caption.
  const xt = series.xLabel
  const xw = measure([xt], FONT.small).w
  textSk(d, eid(part('xtitle')), px + plotW / 2 - xw / 2, py + plotH + 38, xt, FONT.small, MUTED, pm('xtitle'), 'center')
  note(part('xtitle'))
  const caption = series.illustrative ? 'Illustrative data - not measured' : series.source ? `Source: ${series.source}` : ''
  if (caption) {
    textSk(d, eid(part('caption')), at.x, py + plotH + 66, caption, FONT.small, series.illustrative ? ACCENT_DEEP : MUTED, pm('caption'))
    note(part('caption'))
  }
  focusOn(d, ids)
}

function tableOp(d: Draft, op: Extract<VisualOp, { op: 'table' }>): void {
  const cols = op.columns.length
  const widths = op.columns.map((c, i) => {
    const longest = Math.max(c.length, ...op.rows.map((r) => r[i]?.length ?? 0))
    return Math.max(120, Math.min(260, Math.ceil(longest * FONT.node * 0.6) + 36))
  })
  const all = [op.columns, ...op.rows]
  // Each column wraps to its own width; a row is as tall as its tallest cell.
  const wrapAt = widths.map((w) => Math.max(8, Math.floor((w - 28) / ((FONT.node - 1) * 0.6))))
  const cellText = all.map((row) => row.slice(0, cols).map((cell, c) => wrapText(cell, wrapAt[c]).join('\n')))
  const rowHs = cellText.map((row) => Math.max(50, ...row.map((t) => measure(t.split('\n'), FONT.node - 1).h + 24)))
  const rowY = rowHs.map((_, r) => rowHs.slice(0, r).reduce((a, b) => a + b, 0))
  const titleH = op.title ? 48 : 0
  const size = { w: widths.reduce((a, b) => a + b, 0), h: titleH + rowHs.reduce((a, b) => a + b, 0) }
  const at = findFreeRect(size, d.world.obstacles(), d.usable, { fresh: !!op.new_region })
  const ids: string[] = []
  if (op.title) {
    putTitle(d, eid(`${op.id}__title`), op.id, at.x, at.y, op.title)
    ids.push(eid(`${op.id}__title`))
  }
  // One shadow behind the whole grid makes the table read as a single card.
  putShadow(d, op.id, 'rectangle', { x: at.x, y: at.y + titleH, w: size.w, h: size.h - titleH }, colorOf('pink').shade, op.id)
  ids.push(shadowId(op.id))
  all.forEach((row, r) => {
    let x = at.x
    row.slice(0, cols).forEach((cell, c) => {
      const rect = { x, y: at.y + titleH + rowY[r], w: widths[c], h: rowHs[r] }
      const id = `${op.id}__r${r}c${c}`
      const meta = d.meta({ id, kind: 'part', block: op.id })
      const header = r === 0
      d.put(
        sk({
          type: 'rectangle',
          id: eid(id),
          x: rect.x,
          y: rect.y,
          width: rect.w,
          height: rect.h,
          strokeColor: INK,
          backgroundColor: header ? INK : r % 2 === 0 ? '#fbf7f9' : '#ffffff',
          fillStyle: 'solid',
          strokeWidth: 1.5,
          roughness: 0,
          label: { text: cellText[r][c], fontSize: FONT.node - 1, fontFamily: header ? DISPLAY_FAMILY : FONT_FAMILY, strokeColor: header ? '#ffffff' : INK, textAlign: 'center', verticalAlign: 'middle' },
          customData: { echo: meta }
        }),
        rect,
        meta,
        cell
      )
      ids.push(eid(id))
      x += widths[c]
    })
  })
  focusOn(d, ids)
}

function timelineOp(d: Draft, op: Extract<VisualOp, { op: 'timeline' }>): void {
  const n = op.events.length
  const step = 200
  const titleH = op.title ? 48 : 0
  const size = { w: step * n, h: titleH + 190 }
  const at = findFreeRect(size, d.world.obstacles(), d.usable, { fresh: !!op.new_region })
  const lineY = at.y + titleH + 95
  const ids: string[] = []
  if (op.title) {
    putTitle(d, eid(`${op.id}__title`), op.id, at.x, at.y, op.title)
    ids.push(eid(`${op.id}__title`))
  }
  const pm = (id: string): EchoMeta => d.meta({ id, kind: 'part', block: op.id })
  d.put(sk({ type: 'line', id: eid(`${op.id}__line`), x: at.x, y: lineY, points: [[0, 0], [size.w, 0]], strokeColor: INK, strokeWidth: 3, roughness: 0, customData: { echo: pm(`${op.id}__line`) } }), { x: at.x, y: lineY, w: size.w, h: 0 }, pm(`${op.id}__line`))
  ids.push(eid(`${op.id}__line`))
  op.events.forEach((ev, i) => {
    const cx = at.x + step * (i + 0.5)
    const above = i % 2 === 0
    const lines = [...wrapText(ev.label, 20), ...(ev.detail ? wrapText(ev.detail, 24) : [])]
    const m = measure(lines, FONT.small)
    const meta = d.meta({ id: ev.id, kind: 'node', block: op.id, label: ev.label, detail: ev.detail, color: 'pink', shape: 'round' })
    putNode(d, { x: cx - 12, y: lineY - 12, w: 24, h: 24 }, '', 'round', 'pink', meta)
    ids.push(eid(ev.id))
    const textH = m.h + (ev.when ? 24 : 0)
    const ty = above ? lineY - 28 - textH : lineY + 28
    let y = ty
    if (ev.when) {
      const ww = measure([ev.when], FONT.small).w
      textSk(d, eid(`${ev.id}__when`), cx - ww / 2, y, ev.when, FONT.small + 2, ACCENT_DEEP, pm(`${ev.id}__when`), 'center', DISPLAY_FAMILY)
      ids.push(eid(`${ev.id}__when`))
      y += 24
    }
    textSk(d, eid(`${ev.id}__text`), cx - m.w / 2, y, lines.join('\n'), FONT.small, INK, pm(`${ev.id}__text`), 'center')
    ids.push(eid(`${ev.id}__text`))
  })
  focusOn(d, ids)
}

function noteOp(d: Draft, op: Extract<VisualOp, { op: 'note' }>): void {
  const lines = wrapText(op.text, 26)
  const m = measure(lines, FONT.small + 1)
  const size = { w: Math.max(140, m.w + 36), h: m.h + 30 }
  const near = op.near ? d.world.resolve(op.near) : undefined
  const rect = near ? findSlotNear(near.rect, size, 'below', d.world.slotObstacles(), 60) : findFreeRect(size, d.world.obstacles(), d.usable)
  const meta = d.meta({ id: op.id, kind: 'note', color: op.color })
  putNote(d, rect, lines.join('\n'), op.color, meta)
  if (near) reveal(d, [eid(op.id), shadowId(op.id)], [near.id])
  else focusOn(d, [eid(op.id), shadowId(op.id)])
}

const STICKY = { stroke: INK, fill: '#fff4b8', shade: '#f5cf4d' }
/** Sticky notes sit at a slight, consistent tilt so they read as handwritten asides. */
const NOTE_ANGLE = -0.025

function putNote(d: Draft, rect: Rect, text: string, color: string | undefined, meta: EchoMeta, opacity = 100): void {
  const c = color ? colorOf(color) : STICKY
  putShadow(d, meta.id, 'rectangle', rect, c.shade, meta.block, opacity, NOTE_ANGLE)
  d.put(
    sk({
      type: 'rectangle',
      id: eid(meta.id),
      x: rect.x,
      y: rect.y,
      width: rect.w,
      height: rect.h,
      angle: NOTE_ANGLE,
      strokeColor: c.stroke,
      backgroundColor: c.fill,
      fillStyle: 'solid',
      strokeWidth: 2,
      roughness: 0,
      opacity,
      roundness: { type: 3 },
      groupIds: stickerGroup(meta.id),
      label: { text, fontSize: FONT.small + 1, fontFamily: FONT_FAMILY, strokeColor: INK, textAlign: 'center', verticalAlign: 'middle' },
      customData: { echo: meta }
    }),
    rect,
    meta,
    text
  )
}

function clearHighlights(d: Draft): void {
  for (const el of d.world.echoElements()) {
    if (el.echo!.kind === 'ring') d.remove(el.id)
    else if (el.opacity < 100) {
      d.patch(el.id, { opacity: 100 })
      el.opacity = 100
    }
  }
  // Bound labels of dimmed containers were dimmed too.
  for (const el of d.world.elements.values()) if (el.type === 'text' && el.containerId && el.opacity < 100) d.patch(el.id, { opacity: 100 })
}

const ringId = (ref: string): string => `hl_${ref.replace(/[^a-z0-9_]/gi, '_')}`

function highlightOp(d: Draft, op: Extract<VisualOp, { op: 'highlight' }>): void {
  clearHighlights(d)
  type Target = { ref: string; rect: Rect; el?: NonNullable<ReturnType<World['resolve']>> }
  const targets: Target[] = []
  for (const t of op.targets) {
    const el = d.world.resolve(t)
    if (el) {
      targets.push({ ref: t, rect: el.rect, el })
      continue
    }
    // A block id (a whole diagram, chart, table or timeline): ring its overall bounds.
    const members = d.world.blockMembers(t).filter((m) => m.echo!.kind !== 'ring' && !(m.type === 'text' && m.containerId))
    const box = union(members.map((m) => m.rect))
    if (box) targets.push({ ref: t, rect: box })
  }
  if (!targets.length) {
    d.warnings.push('highlight skipped: no matching elements')
    return
  }
  for (const { ref, rect } of targets) {
    const id = ringId(ref)
    // A soft wide glow under a crisp ring: reads as "lit up" rather than "boxed".
    const layers = [
      { id: `${id}__glow`, pad: 14, width: 12, opacity: 22 },
      { id, pad: 11, width: 3.5, opacity: 100 }
    ]
    for (const l of layers) {
      const r = { x: rect.x - l.pad, y: rect.y - l.pad, w: rect.w + l.pad * 2 + SHADOW.x, h: rect.h + l.pad * 2 + SHADOW.y }
      const meta = d.meta({ id: l.id, kind: 'ring' })
      d.put(
        sk({ type: 'rectangle', id: eid(l.id), x: r.x, y: r.y, width: r.w, height: r.h, strokeColor: ACCENT, backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: l.width, roughness: 0, opacity: l.opacity, roundness: { type: 3 }, customData: { echo: meta } }),
        r,
        meta
      )
    }
  }
  const blocks = [...new Set(targets.map((t) => t.el?.echo?.block).filter((b): b is string => !!b))]
  const context = blocks.flatMap((b) => blockIds(d, b)).filter((id) => d.world.elements.get(id)?.echo?.kind !== 'ring')
  panTo(d, targets.map((t) => (t.el ? t.el.id : eid(ringId(t.ref)))), context)
  if (op.dim_others) {
    const keep = new Set<string>()
    const blocks = new Set<string>()
    for (const { el } of targets) {
      if (!el) continue
      keep.add(el.id)
      if (el.echo?.block) blocks.add(el.echo.block)
    }
    const keepLogical = new Set(targets.map((t) => t.el?.echo?.id).filter((x): x is string => !!x))
    for (const el of d.world.echoElements()) {
      const m = el.echo!
      if (m.kind === 'ring' || !m.block || !blocks.has(m.block) || keep.has(el.id)) continue
      if (m.kind === 'shadow' && m.of && keepLogical.has(m.of)) continue
      if ((m.kind === 'edge' || (m.kind === 'part' && m.from && m.to)) && (keepLogical.has(m.from!) || keepLogical.has(m.to!))) continue
      d.patch(el.id, { opacity: DIM_OPACITY })
      el.opacity = DIM_OPACITY
      for (const t of d.world.elements.values()) if (t.containerId === el.id) d.patch(t.id, { opacity: DIM_OPACITY })
    }
  }
}

function updateOp(d: Draft, op: Extract<VisualOp, { op: 'update' }>): void {
  const el = d.world.resolve(op.id)
  const m = el?.echo
  if (!el || !m) return
  if (m.kind === 'node') {
    const textChange = op.label !== undefined || op.detail !== undefined
    if (textChange) {
      // If the user edited the label, their version wins.
      const expected = sizeNode({ id: m.id, label: m.label ?? '', detail: m.detail }).text
      if (el.text !== undefined && el.text !== expected && !(m.shape === 'diamond' || m.shape === 'round')) {
        d.warnings.push(`update of "${op.id}" skipped: the user edited it`)
        return
      }
    }
    const label = op.label ?? m.label ?? ''
    const detail = op.detail ?? m.detail
    const color = op.color ?? m.color
    const sized = adjust(sizeNode({ id: m.id, label, detail }), m.shape as NodeSpecT['shape'])
    const cx = el.rect.x + el.rect.w / 2
    const cy = el.rect.y + el.rect.h / 2
    const rect = textChange ? { x: cx - sized.w / 2, y: cy - sized.h / 2, w: sized.w, h: sized.h } : el.rect
    const meta = d.meta({ ...m, label, detail, color })
    putShadow(d, m.id, shapeType(m.shape as NodeSpecT['shape']), rect, colorOf(color).shade, m.block, el.opacity)
    d.put(nodeSkeleton(el.id, rect, textChange ? sized.text : sizeNode({ id: m.id, label: m.label ?? '', detail: m.detail }).text, m.shape as NodeSpecT['shape'], color, meta, el.opacity), rect, meta, sized.text)
    rerouteEdges(d, m.id)
    panTo(d, [el.id])
  } else if (m.kind === 'note' && op.label) {
    const meta = d.meta({ ...m })
    const lines = wrapText(op.label, 26)
    const mm = measure(lines, FONT.small + 1)
    const rect = { x: el.rect.x, y: el.rect.y, w: Math.max(140, mm.w + 36), h: mm.h + 30 }
    const color = op.color ?? m.color
    putNote(d, rect, lines.join('\n'), color, { ...meta, color }, el.opacity)
    panTo(d, [el.id])
  }
}

function moveOp(d: Draft, op: Extract<VisualOp, { op: 'move' }>): void {
  const el = d.world.resolve(op.id)
  const anchor = d.world.resolve(op.near)
  if (!el || !anchor) return
  const obstacles = [...d.world.elements.values()].filter((e) => e.id !== el.id && e.containerId !== el.id && !(e.type === 'text' && e.containerId)).map((e) => e.rect)
  const target = findSlotNear(anchor.rect, { w: el.rect.w, h: el.rect.h }, op.side, obstacles)
  d.patch(el.id, { x: target.x, y: target.y })
  el.rect = target
  const shadow = d.world.elements.get(shadowId(op.id))
  if (shadow) {
    d.patch(shadow.id, { x: target.x + SHADOW.x, y: target.y + SHADOW.y })
    shadow.rect = { ...shadow.rect, x: target.x + SHADOW.x, y: target.y + SHADOW.y }
  }
  rerouteEdges(d, op.id)
  panTo(d, [el.id])
}

function groupOp(d: Draft, op: Extract<VisualOp, { op: 'group' }>): void {
  const members = op.members.map((m) => d.world.resolve(m)).filter((e): e is NonNullable<typeof e> => !!e)
  const nodesBox = union(members.map((m) => m.rect))
  if (!nodesBox) return
  // A diagram title sitting right above the grouped nodes goes inside the boundary rather than being cut by it.
  const titles = [...new Set(members.map((m) => m.echo?.block).filter((b): b is string => !!b))]
    .flatMap((b) => [d.world.elements.get(eid(`${b}:title`)), d.world.elements.get(eid(`${b}__swipe`))])
    .filter((t): t is NonNullable<typeof t> => !!t && overlaps(t.rect, { ...nodesBox, y: nodesBox.y - 90, h: nodesBox.h + 90 }, 0))
  const box = union([nodesBox, ...titles.map((t) => t.rect)])!
  const pad = 30
  // The label sits along the bottom edge: the top edge is usually right under a diagram title.
  const rect = { x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 + (op.label ? 18 : 0) }
  const meta = d.meta({ id: op.id, kind: 'group' })
  d.put(sk({ type: 'rectangle', id: eid(op.id), x: rect.x, y: rect.y, width: rect.w, height: rect.h, strokeColor: '#b5b1a8', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'dashed', roughness: 0, roundness: { type: 3 }, customData: { echo: meta } }), rect, meta)
  if (op.label) {
    const lm = d.meta({ id: `${op.id}__label`, kind: 'part', block: op.id })
    textSk(d, eid(`${op.id}__label`), rect.x + 16, rect.y + rect.h - FONT.small * 1.3 - 12, op.label, FONT.small + 1, ACCENT_DEEP, lm, 'left', DISPLAY_FAMILY)
  }
  reveal(d, [eid(op.id)], [])
}

function removeOp(d: Draft, op: Extract<VisualOp, { op: 'remove' }>): void {
  const logical = new Set(op.ids)
  const doomed = new Set<string>()
  for (const el of d.world.echoElements()) {
    const m = el.echo!
    if (logical.has(m.id) || (m.block && logical.has(m.block)) || (m.of && logical.has(m.of))) doomed.add(el.id)
  }
  // Arrows and highlight rings that point at removed things go with them.
  for (const el of d.world.echoElements()) {
    const m = el.echo!
    if ((m.kind === 'edge' || (m.kind === 'part' && m.from && m.to)) && (doomed.has(eid(m.from!)) || doomed.has(eid(m.to!)))) doomed.add(el.id)
    if (m.kind === 'ring' && [...doomed].some((id) => m.id.replace(/__glow$/, '') === ringId(id.replace(/^echo:/, '')))) doomed.add(el.id)
  }
  for (const id of doomed) d.remove(id)
}

function focusOp(d: Draft, op: Extract<VisualOp, { op: 'focus' }>): void {
  const ids = new Set<string>()
  for (const t of op.targets) {
    if (t.startsWith(USER_REF)) {
      ids.add(t.slice(USER_REF.length))
      continue
    }
    const direct = d.world.elements.get(eid(t))
    if (direct) ids.add(direct.id)
    for (const m of blockIds(d, t)) ids.add(m)
  }
  if (ids.size) {
    d.focusIds = [...ids]
    d.focusMode = 'frame'
  }
}

export function applyOp(d: Draft, op: VisualOp): void {
  switch (op.op) {
    case 'diagram':
      return diagramOp(d, op)
    case 'add':
      return addOp(d, op)
    case 'chart':
      return chartOp(d, op)
    case 'table':
      return tableOp(d, op)
    case 'timeline':
      return timelineOp(d, op)
    case 'note':
      return noteOp(d, op)
    case 'highlight':
      return highlightOp(d, op)
    case 'unhighlight':
      return clearHighlights(d)
    case 'update':
      return updateOp(d, op)
    case 'move':
      return moveOp(d, op)
    case 'group':
      return groupOp(d, op)
    case 'remove':
      return removeOp(d, op)
    case 'focus':
      return focusOp(d, op)
  }
}

/**
 * Translate operations against the CURRENT board (fresh from the renderer) into
 * one atomic batch. User-owned elements are only ever read or ringed, never
 * modified or removed.
 */
export function translateOps(ops: VisualOp[], boardElements: BoardElement[], ctx: TranslateContext): TranslateResult {
  const world = World.from(boardElements)
  const d = new Draft(world, ctx)
  for (const op of ops) {
    try {
      applyOp(d, op)
    } catch (err) {
      d.warnings.push(`${op.op} failed: ${err instanceof Error ? err.message : 'unknown error'}`)
    }
  }
  // Highlights stay on top of what they mark; new elements are appended, so order is already correct.
  const focusIds = d.focusIds
  const context = d.focusMode === 'pan' && d.focusContext.length ? { context: d.focusContext } : {}
  d.batch.focus = focusIds.length ? { ids: focusIds, mode: d.focusMode, ...context, ...(d.focusFit ? { fit: true } : {}) } : undefined
  return { batch: d.batch, focusIds, warnings: d.warnings }
}

export type { Draft }

// --- Virtual board ---------------------------------------------------------------------------
// While one segment is being spoken, the next is planned against what the board WILL show once
// the earlier segments' remaining drawing has been applied. These helpers materialise a batch
// into board-element-shaped data without touching the real board.

export const skeletonBounds = (s: ElementSkeleton): Rect => {
  const pts = s.points as Array<[number, number]> | undefined
  if (Array.isArray(pts) && pts.length) {
    const xs = pts.map((p) => s.x + p[0])
    const ys = pts.map((p) => s.y + p[1])
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
  }
  if (s.type === 'text') {
    const lines = String(s.text ?? '').split('\n')
    const m = measure(lines, Number(s.fontSize ?? FONT.small))
    // Aligned text is anchored at x (see textSk).
    const left = s.textAlign === 'center' ? s.x - m.w / 2 : s.textAlign === 'right' ? s.x - m.w : s.x
    return { x: left, y: s.y, w: m.w, h: m.h }
  }
  return { x: s.x, y: s.y, w: Number(s.width ?? 0), h: Number(s.height ?? 0) }
}

export function skeletonToElement(s: ElementSkeleton): BoardElement {
  const r = skeletonBounds(s)
  const label = (s.label as { text?: string } | undefined)?.text
  const el: Record<string, unknown> = {
    id: s.id,
    type: s.type,
    x: r.x,
    y: r.y,
    width: r.w,
    height: r.h,
    opacity: typeof s.opacity === 'number' ? s.opacity : 100,
    isDeleted: false,
    customData: s.customData,
    boundElements: [],
    containerId: null
  }
  if (s.type === 'text') el.text = s.text
  else if (label) el.text = label // container text is read back from a bound text element on a real board
  return el as BoardElement
}

/** Applies a batch to a list of board elements, producing the board as it will look afterwards. */
export function mergeBatch(elements: BoardElement[], batch: BoardBatch): BoardElement[] {
  const doomed = new Set(batch.remove)
  const out = elements.filter((e) => !doomed.has(e.id))
  const index = new Map(out.map((e, i) => [e.id, i]))
  for (const s of batch.upsert) {
    const el = skeletonToElement(s)
    const at = index.get(el.id)
    if (at === undefined) index.set(el.id, out.push(el) - 1)
    else out[at] = el
  }
  for (const p of batch.patch) {
    const at = index.get(p.id)
    if (at !== undefined) out[at] = { ...out[at], ...(p.changes as object) } as BoardElement
  }
  return out
}
