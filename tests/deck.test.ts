import { describe, expect, it } from 'vitest'
import { DeckStudio, type DeckPort } from '../src/main/deck/deckTools'
import { readVoiceConfig } from '../src/main/voice/config'
import { VoiceSession } from '../src/main/voice/session'
import { freePath } from '../src/main/deck/saveDeck'
import type { ChatPort, ChatRequest, EnginePort, SttHooks, TtsHooks, TtsPort } from '../src/main/voice/ports'
import { DeckLineParser, deckFileName, isEchoPictureSearch, parseSlide, type DeckView } from '../src/shared/deck'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

const lines = (...objs: object[]): string => objs.map((o) => JSON.stringify(o)).join('\n') + '\n'
const header = { kind: 'deck', title: 'Photosynthesis', theme: 'forest' }
const slide = (title: string, extra: object = {}): object => ({ kind: 'slide', layout: 'bullets', title, bullets: ['a', 'b'], notes: 'n', ...extra })

function setup(open = true) {
  const shown: DeckView[] = []
  const saved: string[] = []
  const searches: string[] = []
  const port: DeckPort = {
    show: (v) => shown.push(structuredClone(v)),
    close: () => {},
    isOpen: () => open,
    save: async (d, f) => (saved.push(`${d.title}.${f}`), `/docs/${d.title}.${f}`),
    pictures: { find: async (req) => (searches.push(req.search ?? ''), null) }
  }
  const studio = new DeckStudio(port)
  const said: string[] = []
  studio.setAnnouncer((l) => said.push(l))
  const calls: ChatRequest[] = []
  const chat = (text: string): ChatPort => ({
    stream: async (req) => {
      calls.push(req)
      // Streamed in uneven pieces, as the API does.
      for (let i = 0; i < text.length; i += 7) req.onText(text.slice(i, i + 7))
    }
  })
  return { studio, shown, saved, said, searches, calls, chat }
}

describe('deck lines', () => {
  it('reads streamed JSON lines and skips chatter around them', () => {
    const p = new DeckLineParser()
    const text = lines(header, slide('One'))
    const cut = text.indexOf('\n') + 10 // the header line is complete, the first slide line isn't
    p.push('Here is your deck:\n```\n' + text.slice(0, cut))
    expect(p.header?.title).toBe('Photosynthesis')
    expect(p.slides).toEqual([])
    p.push(text.slice(cut) + lines(slide('Two')) + '```')
    p.end()
    expect(p.slides.map((s) => s.title)).toEqual(['One', 'Two'])
  })

  it('falls back to bullets when a layout is missing what it needs', () => {
    expect(parseSlide({ layout: 'stats', title: 'Numbers', stats: [] })?.layout).toBe('bullets')
    expect(parseSlide({ layout: 'image', title: 'No picture', bullets: ['x'] })?.layout).toBe('bullets')
    expect(parseSlide({ layout: 'quote', quote: { text: '' } })).toBeNull()
  })

  it('recognises a picture of ECHO itself', () => {
    expect(isEchoPictureSearch('ECHO')).toBe(true)
    expect(isEchoPictureSearch("Echo's character art")).toBe(true)
    expect(isEchoPictureSearch('echo chamber')).toBe(false)
  })

  it('makes safe file names that never overwrite', () => {
    expect(deckFileName('Cells: the basics / part 1')).toBe('Cells the basics part 1')
    const taken = new Set(['/d/Cells.pdf', '/d/Cells 2.pdf'])
    expect(freePath('/d', 'Cells', 'pdf', (p) => taken.has(p))).toBe('/d/Cells 3.pdf')
  })
})

describe('DeckStudio', () => {
  it('builds in the background, shows slides as they arrive, and says when it is ready', async () => {
    const t = setup()
    const note = t.studio.handle(
      { name: 'build_presentation', input: { topic: 'Photosynthesis', brief: 'For 10-year-olds', slide_count: 3 } },
      { chat: t.chat(lines(header, slide('Plants make food', { layout: 'title' }), slide('Light'), slide('Thanks', { layout: 'closing' }))), conversation: [], webSearch: false }
    )
    expect(note).toMatch(/started building a 3-slide deck/)
    await flush()
    expect(t.shown.some((v) => v.status.kind === 'building' && v.deck?.slides.length === 1)).toBe(true)
    expect(t.shown.at(-1)?.status.kind).toBe('ready')
    expect(t.said).toEqual([expect.stringMatching(/3-slide deck on Photosynthesis is ready/)])
    expect(t.calls[0].tier).toBe('strong')
  })

  it('opens a deck about ECHO with ECHO’s own picture', async () => {
    const t = setup()
    t.studio.handle(
      { name: 'build_presentation', input: { topic: 'ECHO, the voice tutor', brief: '' } },
      { chat: t.chat(lines({ ...header, title: 'Meet ECHO' }, slide('Meet ECHO', { layout: 'title', image: { search: 'robot' } }), slide('How it works'))), conversation: [], webSearch: false }
    )
    await flush()
    expect(t.shown.at(-1)?.deck?.slides[0].image?.search).toBe('ECHO')
    expect(t.searches).toContain('ECHO')
  })

  it('moves between slides by voice only while the deck window is open', async () => {
    const t = setup()
    t.studio.handle(
      { name: 'build_presentation', input: { topic: 'Photosynthesis', brief: '' } },
      { chat: t.chat(lines(header, slide('One'), slide('Two'), slide('Three'))), conversation: [], webSearch: false }
    )
    await flush()
    const on = (): number => t.studio.view.current + 1
    expect(t.studio.resolveSpoken('next slide')).toBe(true)
    expect(on()).toBe(2)
    expect(t.studio.resolveSpoken('go to slide three please')).toBe(true)
    expect(on()).toBe(3)
    expect(t.studio.resolveSpoken('next')).toBe(true) // past the end: handled, stays put
    expect(on()).toBe(3)
    expect(t.studio.resolveSpoken('go back')).toBe(true)
    expect(on()).toBe(2)
    expect(t.studio.resolveSpoken('the first slide')).toBe(true)
    expect(on()).toBe(1)
    expect(t.studio.resolveSpoken('what is the next step in photosynthesis')).toBe(false)
    const closed = setup(false)
    expect(closed.studio.resolveSpoken('next slide')).toBe(false)
  })

  it('saves by voice and refuses while still writing', async () => {
    const t = setup()
    const ctx = { chat: t.chat(lines(header, slide('One'), slide('Two'))), conversation: [], webSearch: false }
    t.studio.handle({ name: 'build_presentation', input: { topic: 'Photosynthesis', brief: '' } }, ctx)
    expect(t.studio.handle({ name: 'presentation', input: { action: 'save_pdf' } }, ctx)).toMatch(/still being written/)
    await flush()
    expect(t.studio.handle({ name: 'presentation', input: { action: 'save_pptx' } }, ctx)).toMatch(/PowerPoint/)
    await flush()
    expect(t.saved).toEqual(['Photosynthesis.pptx'])
  })
})

// --- In a conversation: moving slides is always silent ------------------------------------------------------

function conversation() {
  const cfg = readVoiceConfig({ ANTHROPIC_API_KEY: 'a', DEEPGRAM_API_KEY: 'd' })
  if (!cfg.ok) throw new Error('config')
  const t = setup()
  const voiceCalls: ChatRequest[] = []
  const scripts: Array<(req: ChatRequest) => void> = []
  const spoken: string[] = []
  const cleared: string[] = []
  let stt: SttHooks | null = null
  const engine: EnginePort = {
    start() {},
    stop() {},
    setMuted() {},
    sendAudio() {},
    segmentMarker() {},
    responseDone() {},
    clearPlayback: (id) => cleared.push(id),
    duck() {}
  }
  const tts = (_h: TtsHooks): TtsPort => ({
    ensureConnected() {},
    begin() {},
    speak: (text) => spoken.push(text),
    canFlush: () => true,
    flush: () => 0,
    clear() {},
    close() {}
  })
  const session = new VoiceSession({
    config: cfg.config,
    engine,
    chat: { stream: async (req) => (voiceCalls.push(req), scripts.shift()?.(req)) },
    createStt: (h) => ((stt = h), { connect() {}, sendAudio() {}, forceEndTurn() {}, close() {} }),
    createTts: tts,
    emit: () => {},
    log: () => {},
    deck: t.studio
  })
  session.start()
  session.onEngineReady()
  stt!.onStatus({ kind: 'connected' })
  let n = 0
  const say = async (text: string): Promise<void> => {
    stt!.onTurn({ event: 'StartOfTurn', transcript: text.split(' ')[0], turnIndex: n })
    stt!.onTurn({ event: 'EndOfTurn', transcript: text, turnIndex: n })
    n += 1
    await flush()
  }
  return { ...t, session, voiceCalls, scripts, spoken, cleared, say }
}

async function withDeck() {
  const c = conversation()
  c.studio.handle(
    { name: 'build_presentation', input: { topic: 'Photosynthesis', brief: '' } },
    { chat: c.chat(lines(header, slide('One'), slide('Two'), slide('Three'))), conversation: [], webSearch: false }
  )
  await flush()
  await new Promise((r) => setTimeout(r, 0)) // the "deck is ready" line
  c.spoken.length = 0
  return c
}

describe('slide navigation in a conversation', () => {
  it('moves on "next slide" without asking the model or saying a word', async () => {
    const c = await withDeck()
    await c.say('Next slide.')
    await c.say('go back')
    await c.say('slide three')
    expect(c.voiceCalls).toEqual([])
    expect(c.spoken).toEqual([])
    expect(c.studio.view.current).toBe(2)
  })

  it('cuts off anything the model says when it moves the slide itself', async () => {
    const c = await withDeck()
    c.scripts.push((r) => {
      r.onText('Sure, here is the slide about light. ')
      r.onToolUse?.({ name: 'presentation', input: { action: 'go_to', slide: 2 } })
    })
    await c.say('show me the one about light')
    expect(c.studio.view.current).toBe(1)
    expect(c.cleared.length).toBeGreaterThan(0) // what was already queued for speech is dropped
    // The next question is answered on its own: not merged with the slide command, and the cut-off words were
    // never kept as something ECHO said.
    c.scripts.push((r) => r.onText('Plants use light to make sugar.'))
    await c.say('What do plants use light for?')
    const sent = c.voiceCalls.at(-1)!.messages
    expect(sent.at(-1)?.content).toBe('What do plants use light for?')
    expect(sent.some((m) => String(m.content).includes('here is the slide'))).toBe(false)
  })
})
