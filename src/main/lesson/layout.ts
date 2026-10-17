// Pure geometry for the visuals renderer: text measurement, diagram layouts,
// free-space placement and arrow endpoints. No Excalidraw or Electron
// imports, so it is fully unit-testable.

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export const FONT = { node: 18, edge: 16, title: 26, small: 15 } as const
/** Average glyph width as a fraction of font size; deliberately generous so text never overflows its box. */
const CHAR_W = 0.6
const LINE_H = 1.3

export function wrapText(text: string, maxChars: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && (line + ' ' + word).length > maxChars) {
        out.push(line)
        line = word
      } else line = line ? line + ' ' + word : word
    }
    out.push(line)
  }
  return out.length ? out : ['']
}

export function measure(lines: string[], fontSize: number): { w: number; h: number } {
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 0)
  return { w: Math.ceil(longest * fontSize * CHAR_W), h: Math.ceil(lines.length * fontSize * LINE_H) }
}

export interface NodeLike {
  id: string
  label: string
  detail?: string
}

export interface SizedNode extends NodeLike {
  w: number
  h: number
  /** Wrapped text (label, then detail) as it will be drawn. */
  text: string
}

export function sizeNode(n: NodeLike): SizedNode {
  const labelLines = wrapText(n.label, 18)
  const detailLines = n.detail ? wrapText(n.detail, 22) : []
  const lines = [...labelLines, ...detailLines]
  const m = measure(lines, FONT.node)
  return {
    ...n,
    text: lines.join('\n'),
    w: Math.max(130, Math.min(300, m.w + 44)),
    h: Math.max(64, m.h + 34)
  }
}

export interface EdgeLike {
  from: string
  to: string
  label?: string
}

export type LayoutKind = 'row' | 'column' | 'grid' | 'cycle' | 'hub' | 'tree'

export interface Placed {
  id: string
  rect: Rect
}

export interface LaidOut {
  nodes: Placed[]
  /** Bounding box of all nodes, with its top-left at (0,0). */
  size: { w: number; h: number }
}

// Rows wrap only when very long: the camera frames each new diagram, so a wide row reads better than a
// second row joined by a long diagonal arrow.
const MAX_ROW_W = 2100

/** Extra space between neighbours so arrow labels fit on the arrow. */
function gapFor(edges: EdgeLike[], base: number): number {
  const longest = edges.reduce((m, e) => Math.max(m, e.label ? measure([e.label], FONT.edge).w : 0), 0)
  return Math.max(base, longest + 56)
}

function normalize(nodes: Placed[]): LaidOut {
  const minX = Math.min(...nodes.map((n) => n.rect.x))
  const minY = Math.min(...nodes.map((n) => n.rect.y))
  const shifted = nodes.map((n) => ({ id: n.id, rect: { ...n.rect, x: n.rect.x - minX, y: n.rect.y - minY } }))
  return {
    nodes: shifted,
    size: {
      w: Math.max(...shifted.map((n) => n.rect.x + n.rect.w)),
      h: Math.max(...shifted.map((n) => n.rect.y + n.rect.h))
    }
  }
}

export function layoutNodes(kind: LayoutKind, nodes: SizedNode[], edges: EdgeLike[]): LaidOut {
  const n = nodes.length
  const hgap = gapFor(edges, 90)
  const vgap = 76

  if (kind === 'column') {
    let y = 0
    const placed = nodes.map((nd) => {
      const p = { id: nd.id, rect: { x: 0, y, w: nd.w, h: nd.h } }
      y += nd.h + vgap
      return p
    })
    return centerColumns(placed)
  }

  if (kind === 'row' || kind === 'grid') {
    const cols = kind === 'grid' ? (n <= 2 ? n : n <= 4 ? 2 : 3) : 0
    const rows: SizedNode[][] = [[]]
    let rowW = 0
    for (const nd of nodes) {
      const row = rows[rows.length - 1]
      const full = kind === 'grid' ? row.length >= cols : row.length > 0 && rowW + hgap + nd.w > MAX_ROW_W
      if (full) {
        rows.push([nd])
        rowW = nd.w
      } else {
        rowW += (row.length ? hgap : 0) + nd.w
        row.push(nd)
      }
    }
    const placed: Placed[] = []
    let y = 0
    for (const row of rows) {
      let x = 0
      const rowH = Math.max(...row.map((r) => r.h))
      for (const nd of row) {
        placed.push({ id: nd.id, rect: { x, y: y + (rowH - nd.h) / 2, w: nd.w, h: nd.h } })
        x += nd.w + hgap
      }
      y += rowH + vgap
    }
    return normalize(placed)
  }

  if (kind === 'cycle' || kind === 'hub') {
    const maxW = Math.max(...nodes.map((nd) => nd.w))
    const maxH = Math.max(...nodes.map((nd) => nd.h))
    const ring = kind === 'hub' ? nodes.slice(1) : nodes
    const count = Math.max(ring.length, 1)
    const arc = maxW + Math.max(60, hgap - 30)
    const radius = Math.max(kind === 'hub' ? 230 : 170, (count * arc) / (2 * Math.PI), maxH + 80)
    const placed: Placed[] = []
    if (kind === 'hub') {
      const c = nodes[0]
      placed.push({ id: c.id, rect: { x: -c.w / 2, y: -c.h / 2, w: c.w, h: c.h } })
    }
    ring.forEach((nd, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / count
      const cx = Math.cos(a) * radius * 1.35 // wider than tall: boxes are wider than they are high
      const cy = Math.sin(a) * radius
      placed.push({ id: nd.id, rect: { x: cx - nd.w / 2, y: cy - nd.h / 2, w: nd.w, h: nd.h } })
    })
    return normalize(placed)
  }

  // tree: BFS levels from the first node along edges.
  const byId = new Map(nodes.map((nd) => [nd.id, nd]))
  const level = new Map<string, number>([[nodes[0].id, 0]])
  const queue = [nodes[0].id]
  while (queue.length) {
    const cur = queue.shift()!
    for (const e of edges) {
      const next = e.from === cur ? e.to : e.to === cur ? e.from : null
      if (next && byId.has(next) && !level.has(next)) {
        level.set(next, level.get(cur)! + 1)
        queue.push(next)
      }
    }
  }
  const maxLevel = Math.max(...level.values())
  for (const nd of nodes) if (!level.has(nd.id)) level.set(nd.id, maxLevel + 1)
  const levels = new Map<number, SizedNode[]>()
  for (const nd of nodes) levels.set(level.get(nd.id)!, [...(levels.get(level.get(nd.id)!) ?? []), nd])
  const widths = [...levels.entries()].map(([, row]) => row.reduce((s, r) => s + r.w, 0) + (row.length - 1) * hgap)
  const widest = Math.max(...widths)
  const placed: Placed[] = []
  let y = 0
  for (const [, row] of [...levels.entries()].sort((a, b) => a[0] - b[0])) {
    const rowW = row.reduce((s, r) => s + r.w, 0) + (row.length - 1) * hgap
    let x = (widest - rowW) / 2
    const rowH = Math.max(...row.map((r) => r.h))
    for (const nd of row) {
      placed.push({ id: nd.id, rect: { x, y, w: nd.w, h: nd.h } })
      x += nd.w + hgap
    }
    y += rowH + vgap
  }
  return normalize(placed)
}

function centerColumns(placed: Placed[]): LaidOut {
  const maxW = Math.max(...placed.map((p) => p.rect.w))
  return normalize(placed.map((p) => ({ id: p.id, rect: { ...p.rect, x: (maxW - p.rect.w) / 2 } })))
}

// --- Free space -----------------------------------------------------------------------

export const overlaps = (a: Rect, b: Rect, pad = 0): boolean =>
  a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y

export const union = (rects: Rect[]): Rect | null => {
  if (!rects.length) return null
  const x = Math.min(...rects.map((r) => r.x))
  const y = Math.min(...rects.map((r) => r.y))
  return {
    x,
    y,
    w: Math.max(...rects.map((r) => r.x + r.w)) - x,
    h: Math.max(...rects.map((r) => r.y + r.h)) - y
  }
}

export interface ViewInfo {
  /** Visible region in scene coordinates, already reduced by UI insets (toolbar, voice dock). */
  usable: Rect
}

/** Visible scene rectangle from Excalidraw's camera, minus space covered by floating UI. */
export function usableView(
  vp: { scrollX: number; scrollY: number; zoom: number; width?: number; height?: number },
  insets = { top: 150, bottom: 212, left: 24, right: 24 }
): Rect {
  const zoom = vp.zoom || 1
  const sw = vp.width ?? 1280
  const sh = vp.height ?? 760
  return {
    x: -vp.scrollX + insets.left / zoom,
    y: -vp.scrollY + insets.top / zoom,
    w: Math.max(200, (sw - insets.left - insets.right) / zoom),
    h: Math.max(160, (sh - insets.top - insets.bottom) / zoom)
  }
}

/**
 * First free spot for a w×h block: scan the usable viewport, then fall back to
 * the area to the right of (or below) all existing content so nothing overlaps.
 */
export function findFreeRect(size: { w: number; h: number }, obstacles: Rect[], view: Rect, opts: { fresh?: boolean } = {}): Rect {
  const pad = 36
  const content = union(obstacles)
  if (!opts.fresh) {
    const step = 28
    for (let y = view.y; y + size.h <= view.y + view.h; y += step) {
      for (let x = view.x; x + size.w <= view.x + view.w; x += step) {
        const r = { x, y, w: size.w, h: size.h }
        if (!obstacles.some((o) => overlaps(r, o, pad))) return r
      }
    }
  }
  if (!content) return { x: view.x, y: view.y, ...size }
  // Beside the existing content, aligned to the top of the viewport.
  return { x: content.x + content.w + 90, y: Math.min(content.y, view.y), ...size }
}

/** A free slot of the given size next to `anchor`, trying the preferred side first. */
export function findSlotNear(
  anchor: Rect,
  size: { w: number; h: number },
  side: 'right' | 'left' | 'above' | 'below',
  obstacles: Rect[],
  gap = 100,
  within?: Rect
): Rect {
  const order: Array<'right' | 'left' | 'above' | 'below'> = [side, ...(['right', 'below', 'left', 'above'] as const).filter((s) => s !== side)]
  // First choice: a free slot that is also inside the visible region; then any free slot.
  for (const requireInside of within ? [true, false] : [false]) {
    for (const s of order) {
      for (let k = 0; k < 6; k++) {
        // Slide along the edge (0, +1, -1, +2, ...) before giving up on this side.
        const shift = ((k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2)) * (s === 'right' || s === 'left' ? size.h + 30 : size.w + 30)
        const r = slotRect(anchor, size, s, gap, shift)
        if (requireInside && !rectContains(within!, r)) continue
        if (!obstacles.some((o) => overlaps(r, o, 20))) return r
      }
    }
  }
  const all = union([anchor, ...obstacles])!
  return { x: all.x + all.w + 90, y: anchor.y, ...size }
}

function slotRect(a: Rect, s: { w: number; h: number }, side: 'right' | 'left' | 'above' | 'below', gap: number, shift: number): Rect {
  switch (side) {
    case 'right':
      return { x: a.x + a.w + gap, y: a.y + (a.h - s.h) / 2 + shift, w: s.w, h: s.h }
    case 'left':
      return { x: a.x - gap - s.w, y: a.y + (a.h - s.h) / 2 + shift, w: s.w, h: s.h }
    case 'below':
      return { x: a.x + (a.w - s.w) / 2 + shift, y: a.y + a.h + gap * 0.7, w: s.w, h: s.h }
    case 'above':
      return { x: a.x + (a.w - s.w) / 2 + shift, y: a.y - gap * 0.7 - s.h, w: s.w, h: s.h }
  }
}

/** Arrow from the edge of `a` to the edge of `b`, along the line between their centres. */
export function edgeEndpoints(a: Rect, b: Rect, gap = 4): { sx: number; sy: number; ex: number; ey: number } {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
  const dx = bc.x - ac.x
  const dy = bc.y - ac.y
  const border = (r: Rect, c: { x: number; y: number }, sign: 1 | -1): { x: number; y: number } => {
    if (dx === 0 && dy === 0) return c
    const tx = dx === 0 ? Infinity : r.w / 2 / Math.abs(dx)
    const ty = dy === 0 ? Infinity : r.h / 2 / Math.abs(dy)
    const t = Math.min(tx, ty)
    return { x: c.x + sign * dx * t, y: c.y + sign * dy * t }
  }
  const s = border(a, ac, 1)
  const e = border(b, bc, -1)
  const len = Math.hypot(e.x - s.x, e.y - s.y) || 1
  const ux = (e.x - s.x) / len
  const uy = (e.y - s.y) / len
  return { sx: s.x + ux * gap, sy: s.y + uy * gap, ex: e.x - ux * gap, ey: e.y - uy * gap }
}

/** "Nice" axis maximum and tick step for chart scales. */
export function niceScale(max: number, ticks = 5): { max: number; step: number } {
  if (!(max > 0)) return { max: 1, step: 0.2 }
  const raw = max / ticks
  const pow = Math.pow(10, Math.floor(Math.log10(raw)))
  const frac = raw / pow
  const step = (frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 2.5 ? 2.5 : frac <= 5 ? 5 : 10) * pow
  return { max: Math.ceil(max / step) * step, step }
}

// --- Arrow routing ------------------------------------------------------------------------------

export interface Pt {
  x: number
  y: number
}

/** Does the segment a→b cross the (inflated) rectangle? */
export function segmentHitsRect(a: Pt, b: Pt, r: Rect, pad = 10): boolean {
  const x0 = r.x - pad
  const y0 = r.y - pad
  const x1 = r.x + r.w + pad
  const y1 = r.y + r.h + pad
  let t0 = 0
  let t1 = 1
  const dx = b.x - a.x
  const dy = b.y - a.y
  for (const [p, q] of [
    [-dx, a.x - x0],
    [dx, x1 - a.x],
    [-dy, a.y - y0],
    [dy, y1 - a.y]
  ]) {
    if (p === 0) {
      if (q < 0) return false
    } else {
      const t = q / p
      if (p < 0) {
        if (t > t1) return false
        if (t > t0) t0 = t
      } else {
        if (t < t0) return false
        if (t < t1) t1 = t
      }
    }
  }
  return true
}

export interface Route {
  /** Polyline from the border of `from` to the border of `to` (2 points = straight). */
  points: Pt[]
  /** Where an arrow label belongs: the middle of the line's longest run, and that run's direction (unit vector). */
  label: { at: Pt; dir: Pt }
}

/**
 * Straight line between two rectangles, unless it would pass through another
 * element; then a single bend around the obstacles, on whichever side is clearer.
 */
export function routeEdge(from: Rect, to: Rect, obstacles: Rect[], lane = 0): Route {
  const direct = edgeEndpoints(from, to)
  let a = { x: direct.sx, y: direct.sy }
  let b = { x: direct.ex, y: direct.ey }
  if (lane) {
    // Parallel lane: arrows in opposite directions between the same two things run side by side, not on top of each other.
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1
    const nx = -(b.y - a.y) / l
    const ny = (b.x - a.x) / l
    a = { x: a.x + nx * lane, y: a.y + ny * lane }
    b = { x: b.x + nx * lane, y: b.y + ny * lane }
  }
  const blockers = obstacles.filter((o) => segmentHitsRect(a, b, o))
  const horizontalish = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y)
  const labelFor = (p: Pt[]): Route['label'] => {
    // Label sits on the longest segment's middle (the apex segment for a bent route).
    let best = 0
    let bi = 0
    for (let i = 0; i < p.length - 1; i++) {
      const len = Math.hypot(p[i + 1].x - p[i].x, p[i + 1].y - p[i].y)
      if (len > best) {
        best = len
        bi = i
      }
    }
    const m = { x: (p[bi].x + p[bi + 1].x) / 2, y: (p[bi].y + p[bi + 1].y) / 2 }
    const dx = p[bi + 1].x - p[bi].x
    const dy = p[bi + 1].y - p[bi].y
    const l = Math.hypot(dx, dy) || 1
    return { at: m, dir: { x: dx / l, y: dy / l } }
  }
  if (!blockers.length) return { points: [a, b], label: labelFor([a, b]) }

  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
  const n = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len }
  let best: { apex: Pt; cost: number } | null = null
  for (const sign of [-1, 1]) {
    // How far must we swing out, on this side, to clear every blocker?
    let d = 0
    for (const o of blockers) {
      const corners = [
        { x: o.x, y: o.y },
        { x: o.x + o.w, y: o.y },
        { x: o.x, y: o.y + o.h },
        { x: o.x + o.w, y: o.y + o.h }
      ]
      for (const c of corners) d = Math.max(d, sign * ((c.x - mid.x) * n.x + (c.y - mid.y) * n.y))
    }
    d += 56
    const apex = { x: mid.x + sign * n.x * d, y: mid.y + sign * n.y * d }
    const hit = obstacles.filter((o) => segmentHitsRect(a, apex, o, 4) || segmentHitsRect(apex, b, o, 4)).length
    // Prefer bending away from titles and the toolbar: below a horizontal run, to the right of a vertical one.
    const preferred = horizontalish ? apex.y >= mid.y : apex.x >= mid.x
    const cost = d + hit * 1000 + (preferred ? 0 : 40)
    if (!best || cost < best.cost) best = { apex, cost }
  }
  const apex = best!.apex
  const sa = edgeEndpoints(from, { x: apex.x, y: apex.y, w: 0, h: 0 }, 4)
  const eb = edgeEndpoints({ x: apex.x, y: apex.y, w: 0, h: 0 }, to, 4)
  const points = [{ x: sa.sx, y: sa.sy }, apex, { x: eb.ex, y: eb.ey }]
  return { points, label: labelFor(points) }
}

export const rectContains = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h
