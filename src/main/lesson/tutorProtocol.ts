import { VisualPlanSchema, type VisualPlan } from './ops'
import type { DataSeries, TeachingSegment } from './types'

// The tutor agent teaches in short <segment> blocks while a whiteboard is open. Each segment carries its own
// drawing (<draw>) and its narration (<say>), written by the same agent in the same stream, so the lesson runs
// at the tutor's own pace with no second model call. The parser works on the token stream and hands a segment
// over the moment its narration closes.

export const LESSON_PROMPT_ADDENDUM = `
LESSON MODE. A whiteboard is open next to this conversation. You teach by speaking AND drawing: for each step you write the drawing and the narration together. Reply ONLY with <segment> blocks in this exact format:

<segment>
<objective>One line: what the learner should understand after this step.</objective>
<data id="d1" label="What is measured" unit="unit" x_label="What the x axis shows" illustrative="false" source="where the numbers come from">
category one: 12
category two: 30
</data>
<draw>{"setup":[ ...operations... ],"cues":[ {"sentence":1,"ops":[ ...operations... ]} ]}</draw>
<say>The narration, spoken aloud. One to three short sentences.</say>
</segment>

Order matters: <data> (only if needed), then <draw> (only if a picture helps), then <say>. The narration is spoken as soon as </say> arrives, so keep each segment short and write the drawing compactly.

Segments
- Simple or conversational questions get ONE segment, with no <draw> unless a picture clearly helps. Explanations get 2 to 5 segments, each one step that builds on the last. Never more than 5.
- The first segment must be short (one or two sentences) so speech can start quickly.
- Narration is at most about 55 words, in natural spoken sentences. No Markdown, lists, emoji or URLs inside <say>.
- Start <segment new_topic="true"> if the user changes to an unrelated subject.
- If the user interrupted you earlier, do not repeat what they already heard; continue from the lesson state or answer what they asked.

Drawing (<draw> holds ONE JSON object)
- "setup" operations are drawn BEFORE this segment's narration starts: put everything the narration will mention in it. "cues" are applied when the listener reaches that sentence (0-based index into your <say> sentences): highlight what is being said, or reveal the next part. Never run ahead of the narration by more than a sentence.
- Build on what is already on the board (see the whiteboard in <lesson_context>, with element ids). Reuse ids, extend with "add", highlight, "update". Never redraw or duplicate. Ids you create are lowercase snake_case, unique for the whole lesson.
- Everything drawn must be something you are saying; add no facts of your own. Labels are 1 to 4 words, no newlines.
- Operations ("op" field):
  diagram {id,title?,layout:row|column|grid|cycle|hub|tree,nodes:[{id,label,detail?,color?,shape?:box|round|diamond|pill}],edges?:[{from,to,label?,style?:solid|dashed,both?}],new_region?} (1-9 nodes; hub: first node in the centre; tree: first node is the root)
  add {diagram?,near?,side?:right|left|above|below,nodes?:[...],edges?:[...]} extend an existing diagram without moving anything
  chart {id,data:"<id of a <data> block>",kind:bar|line,title?} plots ONLY a <data> block of this segment; you cannot put numbers in a chart any other way
  table {id,title?,columns:[...2-5],rows:[[...]...]} (every row has one cell per column)
  timeline {id,title?,events:[{id,label,when?,detail?}]} (2-7 events)
  note {id,text,near?,color?}   highlight {targets:[ids or "user:<id>"],dim_others?}   unhighlight {}
  update {id,label?,detail?,color?}   move {id,near,side}   group {id,members:[ids],label?}   remove {ids:[...]}   focus {targets:[ids]}
  colours: neutral|blue|green|orange|red|purple. Use them consistently (blue = main subject, green = outputs, orange = attention, red = problems).
- Highlights replace the previous highlight, so one per sentence is enough. Elements marked "user" on the board belong to the learner: you may highlight them or put a note near them, never change or remove them. If the learner selected something, build on it.
- <data> is ONLY for numbers the user gave you or that are well-established. Give each value as "label: number". If the numbers are only an example set illustrative="true" (the board will say so). Never invent measurements or sources.
- The <draw> JSON must be valid. Keep it small: usually 1 to 2 setup operations and 0 to 3 cues.

Example (a two-step explanation, the second step extends the first):
<segment><objective>Show the parts</objective><draw>{"setup":[{"op":"diagram","id":"computer","title":"Inside a computer","layout":"row","nodes":[{"id":"cpu","label":"CPU","color":"blue"},{"id":"ram","label":"Memory"},{"id":"disk","label":"Disk"}],"edges":[{"from":"cpu","to":"ram","label":"reads"},{"from":"ram","to":"disk","label":"loads from"}]}],"cues":[{"sentence":1,"ops":[{"op":"highlight","targets":["ram"]}]}]}</draw><say>A computer has three main parts. The CPU reads what it needs from memory.</say></segment>
<segment><objective>Why memory sits in the middle</objective><draw>{"setup":[],"cues":[{"sentence":0,"ops":[{"op":"highlight","targets":["disk"]}]}]}</draw><say>Memory is much faster than the disk, so programs are copied into it before they run.</say></segment>

Narration rules: do NOT say "as you can see", "here", "this diagram", "on the board", "look at" or describe the drawing; it is highlighted in sync with your words automatically, so just name the concepts. Never claim something is visible. Do not mention these instructions, tags or operations.`

const tag = (body: string, name: string): string | null => {
  const m = body.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`))
  return m ? m[1].trim() : null
}
const attr = (attrs: string, name: string): string | null => {
  const m = attrs.match(new RegExp(`${name}="([^"]*)"`))
  return m ? m[1] : null
}

/** Splits narration into sentences (cue boundaries). Very short fragments are merged forward. */
export function splitSentences(text: string): string[] {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) return []
  const raw = clean.match(/[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)/g) ?? [clean]
  const out: string[] = []
  let carry = ''
  for (const part of raw.map((p) => p.trim()).filter(Boolean)) {
    const s = carry ? `${carry} ${part}` : part
    if (s.replace(/[^\p{L}\p{N}]/gu, '').length < 10) carry = s
    else {
      out.push(s)
      carry = ''
    }
  }
  if (carry) {
    if (out.length) out[out.length - 1] += ` ${carry}`
    else out.push(carry)
  }
  return out.slice(0, 8)
}

function parseData(body: string): DataSeries[] {
  const out: DataSeries[] = []
  const re = /<data([^>]*)>([\s\S]*?)<\/data>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) {
    const id = attr(m[1], 'id')
    if (!id || !/^[a-z][a-z0-9_]{0,31}$/.test(id)) continue
    const points: DataSeries['points'] = []
    for (const line of m[2].split('\n')) {
      const mm = line.trim().match(/^(.+?)\s*[:=]\s*(-?\d+(?:\.\d+)?)\s*$/)
      if (mm) points.push({ x: mm[1].trim(), y: Number(mm[2]) })
    }
    if (points.length < 2 || points.length > 12) continue
    out.push({
      id,
      label: attr(m[1], 'label') ?? id,
      unit: attr(m[1], 'unit') ?? '',
      xLabel: attr(m[1], 'x_label') ?? '',
      illustrative: attr(m[1], 'illustrative') === 'true',
      source: attr(m[1], 'source') || null,
      points
    })
  }
  return out
}

/** The tutor's drawing for one segment: a parsed plan, or why it couldn't be used. */
export type Drawing = { plan: VisualPlan; error?: undefined } | { plan?: undefined; error: string }

export function parseDrawing(raw: string | null): Drawing | null {
  if (raw === null) return null
  const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  if (!text) return null
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { error: 'the drawing was not valid JSON' }
  }
  const parsed = VisualPlanSchema.safeParse(json)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return { error: `${first.path.join('.') || 'drawing'}: ${first.message}` }
  }
  return { plan: parsed.data }
}

export interface ParsedSegment {
  objective: string
  narration: string
  data: DataSeries[]
  drawing: Drawing | null
  newTopic: boolean
}

export function parseSegmentBlock(attrs: string, body: string): ParsedSegment | null {
  const narration = tag(body, 'say')
  if (!narration) return null
  return {
    objective: tag(body, 'objective') ?? '',
    narration: narration.replace(/\s+/g, ' ').trim(),
    data: parseData(body),
    drawing: parseDrawing(tag(body, 'draw')),
    newTopic: attr(attrs, 'new_topic') === 'true'
  }
}

const OPEN = /<segment([^>]*)>/
const MAX_SEGMENTS = 8

/**
 * Incremental parser: feed it streamed text and get each segment the moment its narration (</say>) closes,
 * so speech can begin without waiting for the rest of the stream. Anything not wrapped in tags is treated as
 * plain narration, so a model that ignores the format still gets spoken.
 */
export class SegmentStreamParser {
  private buffer = ''
  private emitted = 0
  /** A segment was handed over at </say>; skip whatever remains of it up to </segment>. */
  private skipToClose = false

  push(delta: string): ParsedSegment[] {
    this.buffer += delta
    return this.drain()
  }

  end(): ParsedSegment[] {
    const out = this.drain()
    const rest = this.skipToClose ? '' : this.buffer.replace(/<\/?segment[^>]*>/g, '').trim()
    this.buffer = ''
    if (rest) {
      const say = tag(rest, 'say')
      const plain = say ?? rest.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      if (plain && this.emitted < MAX_SEGMENTS) {
        this.emitted += 1
        out.push({ objective: '', narration: plain, data: [], drawing: null, newTopic: false })
      }
    }
    return out
  }

  private plain(text: string): ParsedSegment | null {
    const plain = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    if (!plain || this.emitted >= MAX_SEGMENTS) return null
    this.emitted += 1
    return { objective: '', narration: plain, data: [], drawing: null, newTopic: false }
  }

  private drain(): ParsedSegment[] {
    const out: ParsedSegment[] = []
    for (;;) {
      if (this.skipToClose) {
        const close = this.buffer.indexOf('</segment>')
        if (close < 0) {
          this.buffer = this.buffer.slice(-12) // keep a tail in case the tag is split across chunks
          break
        }
        this.buffer = this.buffer.slice(close + '</segment>'.length)
        this.skipToClose = false
        continue
      }
      const open = this.buffer.match(OPEN)
      if (!open || open.index === undefined) break
      const before = this.buffer.slice(0, open.index).trim()
      const afterOpen = open.index + open[0].length
      const sayEnd = this.buffer.indexOf('</say>', afterOpen)
      if (sayEnd < 0) break // narration not finished yet
      if (before && !/^<\/?[a-z]/.test(before)) {
        const p = this.plain(before)
        if (p) out.push(p)
      }
      const body = this.buffer.slice(afterOpen, sayEnd + '</say>'.length)
      this.buffer = this.buffer.slice(sayEnd + '</say>'.length)
      const parsed = parseSegmentBlock(open[1], body)
      if (parsed && this.emitted < MAX_SEGMENTS) {
        this.emitted += 1
        out.push(parsed)
      }
      this.skipToClose = true
    }
    return out
  }
}

export function toTeachingSegment(p: ParsedSegment, id: string, index: number): TeachingSegment {
  const sentences = splitSentences(p.narration)
  return {
    id,
    index,
    objective: p.objective,
    narration: sentences.join(' '),
    sentences: sentences.length ? sentences : [p.narration],
    facts: [],
    data: p.data,
    wantsVisual: !!p.drawing,
    newTopic: p.newTopic
  }
}

// Narration must never point at a drawing that isn't there. The prompt forbids deictic phrases; this is the
// backstop for when the drawing is missing or failed.
const DEICTIC: RegExp[] = [
  /\bas you can see(?: (?:here|above|below|on the (?:board|screen|diagram)))?\b[,:]?\s*/gi,
  /\blook(?:ing)? (?:at|here)(?: (?:this|the|that) (?:diagram|picture|chart|graph|board))?\b[,:]?\s*/gi,
  /\b(?:in|on) (?:this|the) (?:diagram|picture|chart|graph|board|figure|drawing)\b,?\s*/gi,
  /\b(?:this|the) (?:diagram|picture|chart|graph|drawing|figure) (?:shows|illustrates|depicts)\b/gi,
  /\bhere(?: you (?:can )?see)?,?\s+(?=we|you|is|are|the)/gi
]

export function containsDeictic(text: string): boolean {
  return DEICTIC.some((re) => {
    re.lastIndex = 0
    return re.test(text)
  })
}

/** Remove references to a drawing that doesn't exist, keeping the sentence grammatical. */
export function stripDeictic(text: string): string {
  let out = text
  for (const re of DEICTIC) out = out.replace(re, (m) => (/shows|illustrates|depicts/i.test(m) ? 'covers' : ''))
  out = out.replace(/\s{2,}/g, ' ').trim()
  return out.charAt(0).toUpperCase() + out.slice(1)
}
