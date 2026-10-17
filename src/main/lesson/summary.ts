import type { BoardElement } from '../../shared/board'
import { union, usableView, type Rect } from './layout'
import { USER_REF, World, eid } from './world'

// A compact, semantic description of the board for the agents: which diagrams
// exist, what their nodes and arrows are called, what the user drew, and what
// they have selected. Bounded so context never grows with the board.

export interface BlockSummary {
  id: string
  kind: 'diagram' | 'chart' | 'table' | 'timeline' | 'code' | 'other'
  title?: string
  /** Code cards: the source as numbered lines, and what the learner's last Run printed. */
  code?: { language: string; lines: string[]; output?: string }
  nodes: Array<{ id: string; label: string; detail?: string }>
  edges: Array<{ from: string; to: string; label?: string }>
  bbox: Rect
}

export interface BoardSummary {
  blocks: BlockSummary[]
  /** Notes and groups the lesson drew outside any block. */
  loose: Array<{ id: string; kind: string; text?: string }>
  /** The user's own drawings (never modified by the lesson). */
  user: Array<{ ref: string; type: string; text?: string }>
  userCount: number
  viewport: { usable: Rect; zoom: number }
}

const MAX_BLOCKS = 8
const MAX_NODES = 12
const MAX_USER = 12

export interface SelectionItem {
  ref: string
  owner: 'lesson' | 'user'
  type: string
  text?: string
}

const round = (r: Rect): Rect => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) })

export function summarizeBoard(elements: BoardElement[], viewport: { scrollX: number; scrollY: number; zoom: number; width?: number; height?: number }): BoardSummary {
  const world = World.from(elements)
  const byBlock = new Map<string, BlockSummary>()
  const loose: BoardSummary['loose'] = []

  for (const el of world.echoElements()) {
    const m = el.echo!
    if (m.kind === 'ring') continue
    if (!m.block) {
      if (m.kind === 'note' || m.kind === 'group') loose.push({ id: m.id, kind: m.kind, text: el.text })
      continue
    }
    let b = byBlock.get(m.block)
    if (!b) {
      b = { id: m.block, kind: 'other', nodes: [], edges: [], bbox: el.rect }
      byBlock.set(m.block, b)
    }
    b.bbox = union([b.bbox, el.rect])!
    if (m.kind === 'code') {
      b.kind = 'code'
      b.code = { language: m.language ?? 'other', lines: (m.code ?? '').split('\n'), ...(b.code?.output ? { output: b.code.output } : {}) }
    } else if (m.id === `${m.block}__out_text` && el.text && el.echo?.detail === 'ran') {
      b.code = { language: b.code?.language ?? 'other', lines: b.code?.lines ?? [], output: el.text }
    } else if (m.kind === 'title') b.title = el.text
    else if (m.kind === 'node') b.nodes.push({ id: m.id, label: m.label ?? el.text ?? '', ...(m.detail ? { detail: m.detail } : {}) })
    else if (m.kind === 'edge') b.edges.push({ from: m.from!, to: m.to!, ...(m.label ? { label: m.label } : {}) })
    else if (m.kind === 'part' && b.kind !== 'code') {
      if (m.id.includes('__bar') || m.id.includes('__dot') || m.id.includes('__yaxis')) b.kind = 'chart'
      else if (/__r\d+c\d+$/.test(m.id)) b.kind = 'table'
      else if (m.id.endsWith('__line') && b.nodes.length) b.kind = 'timeline'
    }
  }
  for (const b of byBlock.values()) {
    if (b.kind === 'other' && b.nodes.length) b.kind = b.edges.length || b.nodes.length > 0 ? 'diagram' : 'other'
    if (b.kind === 'chart' || b.kind === 'table') b.nodes = []
    b.nodes = b.nodes.slice(0, MAX_NODES)
    b.bbox = round(b.bbox)
  }

  const user = world.userElements()
  return {
    blocks: [...byBlock.values()].slice(-MAX_BLOCKS),
    loose: loose.slice(-6),
    user: user.slice(-MAX_USER).map((e) => ({ ref: USER_REF + e.id, type: e.type, ...(e.text ? { text: e.text.slice(0, 60) } : {}) })),
    userCount: user.length,
    viewport: { usable: round(usableView(viewport)), zoom: Math.round(viewport.zoom * 100) / 100 }
  }
}

export function summarizeSelection(selected: BoardElement[]): SelectionItem[] {
  const out: SelectionItem[] = []
  for (const e of selected) {
    if (e.type === 'text' && typeof e.containerId === 'string') continue // the container represents it
    const echo = (e.customData as { echo?: { id: string } } | undefined)?.echo
    const text = typeof e.text === 'string' ? e.text : undefined
    out.push({
      ref: echo ? echo.id : USER_REF + e.id,
      owner: echo ? 'lesson' : 'user',
      type: e.type,
      ...(text ? { text: text.slice(0, 80) } : {})
    })
  }
  return out.slice(0, 8)
}

/** What the tutor is told about the board: element ids (so it can reference them), labels and the user's own drawings. */
/** Links listed per block (blocks and nodes are already capped by summarizeBoard): keeps the context compact. */
const MAX_LINKS = 10

export function describeBoardForTutor(summary: BoardSummary, selection: SelectionItem[]): string {
  const lines: string[] = []
  if (!summary.blocks.length && !summary.userCount) lines.push('The whiteboard is empty.')
  for (const b of summary.blocks) {
    const parts = [`${b.kind} id=${b.id}${b.title ? ` "${b.title}"` : ''}`]
    if (b.code) {
      parts[0] += ` (${b.code.language}; highlight line n as ${b.id}__l<n>)`
      parts.push(`lines: ${b.code.lines.map((l, i) => `${i + 1}: ${l.trimEnd().slice(0, 70)}`).join(' / ')}`)
      if (b.code.output !== undefined) parts.push(`the learner ran it; output: "${b.code.output.replace(/\n/g, ' / ').slice(0, 300)}"`)
    }
    if (b.nodes.length) parts.push(`nodes: ${b.nodes.map((n) => `${n.id} (${n.label})`).join(', ')}`)
    if (b.edges.length) parts.push(`links: ${b.edges.slice(0, MAX_LINKS).map((e) => `${e.from}→${e.to}${e.label ? ` (${e.label})` : ''}`).join('; ')}${b.edges.length > MAX_LINKS ? `, +${b.edges.length - MAX_LINKS} more` : ''}`)
    lines.push(`- ${parts.join(' | ')}`)
  }
  if (summary.userCount) {
    lines.push(`- The user has drawn ${summary.userCount} thing${summary.userCount === 1 ? '' : 's'} of their own: ${summary.user.map((u) => `${u.ref} (${u.type}${u.text ? ` "${u.text}"` : ''})`).join(', ')}.`)
  }
  if (selection.length) {
    lines.push(`The user has selected: ${selection.map((s) => `${s.owner === 'user' ? 'their own' : 'lesson'} ${s.type} id=${s.ref}${s.text ? ` "${s.text.replace(/\n/g, ' ')}"` : ''}`).join(', ')}.`)
  }
  return lines.join('\n')
}

export { eid }
