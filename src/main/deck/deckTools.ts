import { DeckLineParser, deckToLines, ECHO_PICTURE_SEARCH, isAboutEcho, isEchoPictureSearch, MAX_SLIDES, THEME_IDS, type Deck, type DeckView, type Slide } from '../../shared/deck'
import type { PictureLookup } from '../lesson/pictures'
import type { ChatMessage } from '../voice/history'
import { ChatError, type ChatPort, type ChatTool, type ToolCall } from '../voice/ports'

// Presentations ECHO builds by voice. The voice model only decides what the deck is about (build_presentation) or
// what to change (revise_presentation); a separate background request writes the slides, so the conversation never
// waits on them. Slides appear in the deck window as they arrive, and ECHO says when the deck is ready.

export type DeckFormat = 'pdf' | 'pptx'

/** The app side of decks: the window, and saving a file. */
export interface DeckPort {
  /** Opens the deck window (without taking focus) or updates it. */
  show(view: DeckView): void
  close(): void
  /** True while the deck window is on screen (spoken slide commands only apply then). */
  isOpen(): boolean
  /** Saves the deck in the user's Documents folder, opens it, and resolves with where it went. */
  save(deck: Deck, format: DeckFormat): Promise<string>
  pictures?: PictureLookup
}

/** What a build or revision needs from the conversation it was asked in. */
export interface DeckContext {
  chat: ChatPort
  conversation: ChatMessage[]
  webSearch: boolean
  /** The user's study material for this request (<study_material>), so a deck can be built from it directly. */
  material?: string | null
}

export const DECK_TOOLS: ChatTool[] = [
  {
    name: 'build_presentation',
    description:
      'Start building a slide deck (presentation) for the user. It is written in the background and appears slide by slide in its own window; the app tells the user when it is ready. Replaces any deck already open.',
    input_schema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'What the deck is about, as a short title-like phrase.' },
        brief: {
          type: 'string',
          description:
            'Everything the deck writer needs, written out in full: audience, purpose, tone, what to cover and in what order, and any facts, names or numbers from the conversation, screen or study material. The writer cannot see the conversation.'
        },
        slide_count: { type: 'integer', description: `How many slides, 3 to ${MAX_SLIDES}. Default 8 when the user doesn't say.` }
      },
      required: ['topic', 'brief']
    }
  },
  {
    name: 'revise_presentation',
    description: 'Change the deck that is open: reword, add, remove or reorder slides, change the style. The revised deck replaces it when done.',
    input_schema: {
      type: 'object',
      properties: {
        instruction: { type: 'string', description: 'The change, complete and specific, naming slides by number where it matters.' }
      },
      required: ['instruction']
    }
  },
  {
    name: 'presentation',
    description: 'Control the deck window: go to a slide, save the deck as a PDF or PowerPoint file, close the window, or open it again.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['go_to', 'save_pdf', 'save_pptx', 'close', 'open'] },
        slide: { type: 'integer', description: 'go_to only: the slide number, from 1. Moving slides is silent: say nothing at all, before or after.' }
      },
      required: ['action']
    }
  }
]

export const DECK_TOOL_NAMES = new Set(DECK_TOOLS.map((t) => t.name))

/** Moving to another slide, which ECHO always does without a word. */
export function isSlideMove(call: ToolCall): boolean {
  return call.name === 'presentation' && (call.input as Record<string, unknown> | null)?.action === 'go_to'
}

/** Appended to the system prompt whenever the deck tools are offered. */
export const DECK_GUIDE = `MAKING PRESENTATIONS

You can build slide decks for the user, entirely by voice; they never fill anything in.
- When the user asks for a presentation, deck or slides, call build_presentation right away. Don't ask questions first unless the topic itself is unclear: pick a sensible audience, length and tone, and put everything useful from the conversation, screen or study material into the brief.
- The deck is written in the background and appears slide by slide in its own window. After calling it, say in one short sentence that you're making it. Don't list or read out the slides, and don't say it's finished: the app announces that.
- To change the deck, call revise_presentation with the complete change.
- Moving between slides is silent. "Next slide", "go back", "slide three" and the like are usually handled by the app. If one reaches you, call presentation go_to and say nothing at all: no acknowledgement, no slide title, nothing before or after the call. The app cuts off anything you say with it.
- To save, call presentation with save_pdf, or save_pptx when they say PowerPoint, Keynote or pptx (PDF when they don't say). It goes to the Echo Presentations folder in Documents and opens by itself; say so in one short sentence.
- <presentation> in the turn context shows the deck, its slides and the one on screen. Use it to answer questions about the deck.`

/** The deck writer's instructions. */
export const DECK_SYSTEM = `You write slide decks. Output only JSON lines: one JSON object per line, no Markdown, no code fences, no commentary before or after.

Line 1, the header:
{"kind":"deck","title":"...","subtitle":"...","theme":"${THEME_IDS.join('|')}"}
Then one line per slide:
{"kind":"slide","layout":"...","title":"...", ...fields for the layout..., "notes":"..."}

Layouts and their fields:
- title: the opening slide. title, subtitle, optional image {"search":"..."}.
- section: a divider before a new part. title, optional subtitle, optional image.
- bullets: title, bullets (2 to 5 short items).
- image: title, image {"search":"..."}, bullets (1 to 3 short items shown beside the picture).
- quote: title, quote {"text":"...","by":"..."}. Only real, accurately attributed quotes.
- stats: title, stats [{"value":"72%","label":"..."}] (2 to 4). Only figures you are sure of or that the brief gives.
- compare: title, leftTitle, bullets (left column), rightTitle, right (right column).
- closing: the last slide. title (a takeaway or "Questions?"), optional subtitle, optional bullets (up to 3 key points).

Writing good slides:
- Start with a title slide and end with a closing slide. Mix layouts; never more than two bullets slides in a row.
- One idea per slide. Slide titles say the point ("Mitochondria turn food into usable energy"), not just the topic ("Mitochondria").
- Bullets are short phrases, at most about 10 words, no full stops, no sub-bullets. The detail goes in notes.
- notes: what the presenter says on that slide, 2 to 4 natural spoken sentences.
- A picture of ECHO itself (ECHO's character art) is available: use image {"search":"${ECHO_PICTURE_SEARCH}"}. A deck about ECHO puts it on the title slide.
- image search: 2 to 5 plain words naming a real, photographable or diagrammed subject that Wikimedia Commons would have ("red blood cells microscope", "Eiffel Tower"). Use pictures on the title slide and on 2 to 4 other slides where seeing the thing helps; never for abstract ideas.
- theme: ECHO's two looks. paper (the default): warm dot paper like ECHO's whiteboard, for teaching, school and most topics. ink: black with hot pink, like ECHO's app icon, for bold pitches, music, art, tech, and any deck about ECHO itself.
- Don't invent facts, statistics, quotes or sources. When the brief or <study_material> covers the topic, build from it; when a deck is about ECHO itself, use only what <study_material> says about ECHO.
- The title and every text field are plain text: no Markdown, no emoji.`

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty']
const LEAD = String.raw`^(?:(?:ok(?:ay)?|alright|echo|please|and|now|so|um|uh)[\s,]+)*`
const TAIL = String.raw`(?:[\s,]+(?:please|echo|thanks|thank you))*[\s.!]*$`
const NEXT = new RegExp(`${LEAD}(?:(?:go |move |skip )?(?:to )?(?:the )?next(?: slide| one| page)?|(?:go |move )?forward|move on)${TAIL}`, 'i')
const PREVIOUS = new RegExp(`${LEAD}(?:(?:go |move )?back(?: one)?|(?:go |move )?(?:to )?(?:the )?previous(?: slide| one| page)?|(?:go )?back a slide|one back)${TAIL}`, 'i')
const GOTO = new RegExp(
  `${LEAD}(?:(?:go|jump|skip|move|switch|take me) (?:back )?to |show(?: me)? |open )?(?:the )?(?:slide|page)(?: number)? (\\d{1,2}|${NUMBER_WORDS.join('|')})${TAIL}`,
  'i'
)
const FIRST = new RegExp(`${LEAD}(?:(?:go|jump|skip) (?:back )?to |show(?: me)? )?the (?:first|start|beginning)(?: slide)?${TAIL}|${LEAD}(?:start over|back to the (?:start|beginning))${TAIL}`, 'i')
const LAST = new RegExp(`${LEAD}(?:(?:go|jump|skip) to |show(?: me)? )?the (?:last|final|end)(?: slide)?${TAIL}`, 'i')

const BUILD_TOKENS = 9000
const PICTURE_TIMEOUT_MS = 12000

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : ''
}

/** The recent conversation as plain text for the deck writer (it doesn't see the voice model's history). */
function transcript(messages: ChatMessage[]): string {
  return messages
    .slice(-10)
    .map((m) => `${m.role === 'user' ? 'User' : 'ECHO'}: ${m.content.slice(0, 1500)}`)
    .join('\n')
}

/**
 * Holds the one deck ECHO is working on, across conversations, so "save it" still works after a restart of the
 * voice session.
 */
export class DeckStudio {
  private deck: Deck | null = null
  private current = 0
  private status: DeckView['status'] = { kind: 'ready', message: '' }
  private job: AbortController | null = null
  private seq = 0
  private announcer: (line: string) => void = () => {}

  constructor(
    private readonly port: DeckPort,
    private readonly log: (message: string) => void = () => {}
  ) {}

  /** The live conversation, which speaks what the studio has to say (a deck finished, a save failed). */
  setAnnouncer(fn: (line: string) => void): void {
    this.announcer = fn
  }

  get busy(): boolean {
    return !!this.job
  }

  get view(): DeckView {
    return { deck: this.deck, current: this.current, status: this.status }
  }

  /** One of the deck tools. Returns the tool result note; the work itself carries on in the background. */
  handle(call: ToolCall, ctx: DeckContext): string {
    const input = (call.input ?? {}) as Record<string, unknown>
    switch (call.name) {
      case 'build_presentation': {
        const topic = str(input.topic, 200)
        if (!topic) return 'not started: the topic was empty'
        const count = Math.min(MAX_SLIDES, Math.max(3, Math.round(Number(input.slide_count) || 8)))
        const brief = str(input.brief, 6000)
        void this.build(ctx, topic, brief, count)
        return `started building a ${count}-slide deck on "${topic}"; it appears in its own window slide by slide, and the app says when it's ready. Say in one short sentence that you're making it`
      }
      case 'revise_presentation': {
        if (!this.deck) return 'no deck is open. Offer to build one'
        if (this.job) return "the deck is still being written. Say you'll be able to change it in a moment, once it's ready"
        const instruction = str(input.instruction, 3000)
        if (!instruction) return 'nothing changed: the instruction was empty'
        void this.revise(ctx, instruction)
        return 'revising the deck in the background; the window updates when it is done. Say in one short sentence what you are changing'
      }
      case 'presentation':
        return this.control(String(input.action ?? ''), Number(input.slide))
      default:
        return 'unknown tool'
    }
  }

  private control(action: string, slide: number): string {
    const deck = this.deck
    if (!deck?.slides.length) return 'no deck is open. Offer to build one'
    switch (action) {
      case 'go_to':
        // Silent, like the spoken commands: past either end it stays on the first or last slide.
        if (Number.isInteger(slide)) this.select(Math.min(Math.max(slide - 1, 0), deck.slides.length - 1))
        return 'moved. Say nothing'
      case 'save_pdf':
      case 'save_pptx': {
        if (this.job) return "the deck is still being written; say you'll save it once it's ready, and to ask again in a moment"
        const format: DeckFormat = action === 'save_pdf' ? 'pdf' : 'pptx'
        void this.save(deck, format)
        return `saving it as ${format === 'pdf' ? 'a PDF' : 'a PowerPoint file'} in Documents, in the Echo Presentations folder; it opens by itself`
      }
      case 'close':
        this.port.close()
        return 'closed the deck window; it can be opened again'
      case 'open':
        this.publish()
        return 'opened the deck window'
      default:
        return 'unknown action'
    }
  }

  /**
   * "Next slide", "go back", "slide three": a short spoken command moves the deck without the model, and ECHO says
   * nothing (moving slides is always silent, even past either end). True when the turn was such a command.
   */
  resolveSpoken(transcriptText: string): boolean {
    const deck = this.deck
    if (!deck?.slides.length || !this.port.isOpen()) return false
    const t = transcriptText.trim().replace(/\s+/g, ' ')
    if (!t || t.split(' ').length > 8) return false
    let target: number
    if (NEXT.test(t)) target = this.current + 1
    else if (PREVIOUS.test(t)) target = this.current - 1
    else if (FIRST.test(t)) target = 0
    else if (LAST.test(t)) target = deck.slides.length - 1
    else {
      const m = GOTO.exec(t)
      if (!m) return false
      const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS.indexOf(m[1].toLowerCase())
      target = n - 1
    }
    this.select(Math.min(Math.max(target, 0), deck.slides.length - 1))
    return true
  }

  /** What the voice model needs to know about the deck, for the turn context. */
  turnNote(): string | null {
    const deck = this.deck
    if (!deck && !this.job) return null
    const state = this.status.kind
    if (!deck) return `<presentation status="${state}">\nThe deck is being written; no slides yet.\n</presentation>`
    const lines = deck.slides.map((s, i) => `${i + 1}. [${s.layout}] ${s.title || s.quote?.text || ''}`)
    return `<presentation status="${state}" title="${deck.title.replace(/"/g, "'")}">
${deck.slides.length ? `The user is on slide ${this.current + 1} of ${deck.slides.length}.\n${lines.join('\n')}` : 'No slides yet.'}
</presentation>`
  }

  /** The window's own arrows and keys. */
  select(index: number): void {
    if (!this.deck || !Number.isInteger(index) || index < 0 || index >= this.deck.slides.length || index === this.current) return
    this.goTo(index)
  }

  private goTo(index: number): void {
    this.current = index
    this.publish()
  }

  private publish(): void {
    if (this.deck) this.deck = { ...this.deck, version: this.deck.version + 1 }
    this.port.show(this.view)
  }

  private async build(ctx: DeckContext, topic: string, brief: string, count: number): Promise<void> {
    this.job?.abort()
    const job = new AbortController()
    this.job = job
    this.deck = null
    this.current = 0
    this.status = { kind: 'building', message: `Writing "${topic}"…` }
    this.port.show(this.view)
    this.log(`[deck] building "${topic}" (${count} slides)`)
    const conversation = transcript(ctx.conversation)
    const request = [
      conversation ? `<conversation>\n${conversation}\n</conversation>` : null,
      ctx.material ?? null,
      `<request>\nTopic: ${topic}\nSlides: ${count}\n${brief ? `Brief: ${brief}` : ''}\n</request>`,
      `Write the deck now: the header line, then exactly ${count} slide lines.`
    ]
      .filter(Boolean)
      .join('\n\n')
    const parser = new DeckLineParser()
    const id = `deck${++this.seq}`
    const onLines = (): void => {
      if (job.signal.aborted || !parser.header) return
      const known = this.deck?.id === id ? this.deck.slides.length : 0
      const slides = parser.slides
      // A deck about ECHO always opens with ECHO's own picture.
      if (known === 0 && slides[0] && isAboutEcho(topic) && !slides.some((s) => isEchoPictureSearch(s.image?.search))) {
        if (slides[0].layout === 'title' || slides[0].layout === 'section' || slides[0].layout === 'image') slides[0].image = { search: ECHO_PICTURE_SEARCH }
      }
      this.deck = { id, version: this.deck?.version ?? 0, ...parser.header, slides: [...slides] }
      this.status = { kind: 'building', message: `Writing slide ${Math.min(slides.length + 1, count)} of ${count}…` }
      for (let i = known; i < slides.length; i++) void this.findPicture(id, slides[i])
      this.publish()
    }
    const ok = await this.write(ctx, request, parser, job, onLines, ctx.webSearch)
    if (this.job !== job) return
    this.job = null
    // (Written by onLines while the reply streamed in, which the compiler can't see.)
    const deck = this.deck as Deck | null
    if (!ok || !deck || deck.id !== id || deck.slides.length < 2) {
      this.status = { kind: 'failed', message: "Couldn't build this deck." }
      this.port.show(this.view)
      this.announcer("Sorry, I couldn't build that deck. Want me to try again?")
      return
    }
    this.status = { kind: 'ready', message: '' }
    this.publish()
    const n = deck.slides.length
    this.log(`[deck] ready: ${n} slides`)
    this.announcer(`Your ${n}-slide deck on ${deck.title} is ready. Say next to flip through it, ask me to change anything, or tell me to save it.`)
  }

  private async revise(ctx: DeckContext, instruction: string): Promise<void> {
    const before = this.deck!
    const job = new AbortController()
    this.job = job
    this.status = { kind: 'revising', message: 'Making changes…' }
    this.publish()
    this.log('[deck] revising')
    const request = `<current_deck>\n${deckToLines(before)}\n</current_deck>\n\n<change>\n${instruction}\n</change>\n\nWrite the complete revised deck in the same format: the header line, then every slide line. Keep everything the change doesn't touch exactly as it is.`
    const parser = new DeckLineParser()
    const ok = await this.write(ctx, request, parser, job, () => {}, false)
    if (this.job !== job) return
    this.job = null
    if (!ok || !parser.header || parser.slides.length < 2) {
      this.status = { kind: 'ready', message: '' }
      this.publish()
      this.announcer("Sorry, that change didn't work, so the deck is as it was. Want me to try again?")
      return
    }
    // Pictures already found for the same search are kept, so unchanged slides don't flicker or wait.
    const found = new Map(before.slides.filter((s) => s.image && s.picture !== undefined).map((s) => [s.image!.search, s.picture]))
    const slides = parser.slides.map((s) => (s.image && found.has(s.image.search) ? { ...s, picture: found.get(s.image.search) } : s))
    this.deck = { ...before, ...parser.header, slides }
    this.current = Math.min(this.current, slides.length - 1)
    this.status = { kind: 'ready', message: '' }
    for (const s of slides) if (s.image && s.picture === undefined) void this.findPicture(before.id, s)
    this.publish()
    this.log(`[deck] revised: ${slides.length} slides`)
    this.announcer(`Done, I've updated the deck. It has ${slides.length} slides now.`)
  }

  /** Streams the deck writer's reply into the parser. False when it failed (the reason is logged). */
  private async write(ctx: DeckContext, request: string, parser: DeckLineParser, job: AbortController, onLines: () => void, search: boolean): Promise<boolean> {
    try {
      await ctx.chat.stream({
        system: DECK_SYSTEM,
        tier: 'strong',
        reasoning: 'off',
        effort: 'medium',
        maxTokens: BUILD_TOKENS,
        ...(search ? { webSearch: { maxUses: 3 } } : {}),
        messages: [{ role: 'user', content: request }],
        signal: job.signal,
        onText: (delta) => {
          if (parser.push(delta)) onLines()
        }
      })
      if (job.signal.aborted) return false
      if (parser.end()) onLines()
      return true
    } catch (err) {
      this.log(`[deck] writer failed (${err instanceof ChatError ? err.kind : 'other'})`)
      return false
    }
  }

  /** Looks up a slide's picture and shows it once found. The slide object is the deck's own, so it is set in place. */
  private async findPicture(deckId: string, slide: Slide): Promise<void> {
    const lookup = this.port.pictures
    if (!slide.image || !lookup) return
    const signal = AbortSignal.timeout(PICTURE_TIMEOUT_MS)
    const found = await lookup.find({ search: slide.image.search }, signal).catch(() => null)
    if (this.deck?.id !== deckId) return
    const target = this.deck.slides.find((s) => s.image?.search === slide.image!.search && s.picture === undefined)
    if (!target) return
    target.picture = found ? { dataURL: found.dataURL, width: found.width, height: found.height, credit: found.credit } : null
    this.publish()
  }

  private async save(deck: Deck, format: DeckFormat): Promise<void> {
    try {
      await this.port.save(deck, format)
      this.log(`[deck] saved ${format}`)
    } catch (err) {
      this.log(`[deck] save failed: ${err instanceof Error ? err.message : 'unknown error'}`)
      this.announcer(`Sorry, I couldn't save the ${format === 'pdf' ? 'PDF' : 'PowerPoint file'}.`)
    }
  }
}
