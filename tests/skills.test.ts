import Anthropic from '@anthropic-ai/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PreferenceStore } from '../src/main/memory/preferenceStore'
import { SegmentStreamParser, splitSentences } from '../src/main/lesson/tutorProtocol'
import { SKILL_NAMES, SKILLS } from '../src/main/skills'
import { ClaudeChat } from '../src/main/voice/claude'
import { readVoiceConfig } from '../src/main/voice/config'
import { ROUTER_SYSTEM } from '../src/main/voice/intent'
import type { ChatPort, ChatRequest, EnginePort, SttHooks, SttPort, TtsHooks, TtsPort, TurnInfo } from '../src/main/voice/ports'
import { VoiceSession, type LessonSupport } from '../src/main/voice/session'
import { FakeBoard, sleep, until } from './helpers/lesson-fakes'

const segmentsIn = (text: string): string[] => text.match(/<segment[\s\S]*?<\/segment>/g) ?? []

describe('skill files', () => {
  it('every whiteboard example uses the real segment format and valid drawing operations', () => {
    let examples = 0
    for (const name of SKILL_NAMES) {
      for (const block of segmentsIn(SKILLS[name].instructions)) {
        examples += 1
        const parser = new SegmentStreamParser()
        const parsed = [...parser.push(block), ...parser.end()]
        expect(parsed, `${name}: ${block.slice(0, 60)}`).toHaveLength(1)
        const seg = parsed[0]
        expect(seg.objective, name).not.toBe('')
        if (block.includes('<draw>')) {
          expect(seg.drawing?.error, `${name}: ${block.slice(0, 80)}`).toBeUndefined()
          // Cues point at sentences that exist in the narration.
          const sentences = splitSentences(seg.narration).length
          for (const cue of seg.drawing!.plan!.cues) expect(cue.sentence, name).toBeLessThan(sentences)
        }
        expect(seg.narration).not.toMatch(/as you can see|on the board|look at/i)
      }
    }
    expect(examples).toBeGreaterThanOrEqual(5)
  })
})

// --- Through the session, and down to the HTTP request ---------------------------------------------

class FakeStt implements SttPort {
  constructor(readonly hooks: SttHooks) {}
  connect(): void {}
  sendAudio(): void {}
  forceEndTurn(): void {}
  close(): void {}
  turn(event: TurnInfo['event'], transcript: string, turnIndex: number): void {
    this.hooks.onTurn({ event, transcript, turnIndex })
  }
}

class FakeTts implements TtsPort {
  spoken: string[] = []
  constructor(readonly hooks: TtsHooks) {}
  ensureConnected(): void {}
  begin(): void {}
  speak(text: string): void {
    this.spoken.push(text)
  }
  canFlush(): boolean {
    return true
  }
  private n = 0
  flush(): number {
    return this.n++
  }
  clear(): void {}
  close(): void {}
}

const engine: EnginePort = {
  start() {},
  stop() {},
  setMuted() {},
  sendAudio() {},
  segmentMarker() {},
  responseDone() {},
  clearPlayback() {},
  duck() {}
}

/** Answers the routing check with scripted words and every tutor request with one short line. */
class RoutingChat implements ChatPort {
  calls: ChatRequest[] = []
  routes: string[] = []
  async stream(req: ChatRequest): Promise<void> {
    if (req.system === ROUTER_SYSTEM) {
      req.onText(this.routes.shift() ?? 'ANSWER')
      return
    }
    this.calls.push(req)
    req.onText('<segment><objective>x</objective><say>Okay, here is the answer.</say></segment>')
  }
}

function sessionWith(chat: ChatPort, opts: { whiteboard: boolean; lessonSupport?: boolean }) {
  const cfg = readVoiceConfig({ ANTHROPIC_API_KEY: 'a', DEEPGRAM_API_KEY: 'd', ECHO_WEB_SEARCH: 'off' })
  if (!cfg.ok) throw new Error('config')
  const stts: FakeStt[] = []
  const log: string[] = []
  const board = new FakeBoard([])
  const lesson: LessonSupport = { available: () => opts.whiteboard, board: () => (opts.whiteboard ? board : null) }
  const session = new VoiceSession({
    config: cfg.config,
    engine,
    chat,
    ...(opts.lessonSupport === false ? {} : { lesson }),
    createStt: (h) => (stts.push(new FakeStt(h)), stts.at(-1)!),
    createTts: (h) => new FakeTts(h),
    emit: () => {},
    log: (m) => log.push(m)
  })
  session.start()
  session.onEngineReady()
  stts[0].hooks.onStatus({ kind: 'connected' })
  let n = 0
  const ask = (text: string): void => {
    stts[0].turn('StartOfTurn', text.split(' ')[0], n)
    stts[0].turn('EndOfTurn', text, n++)
  }
  return { session, ask, log }
}

const loaded = (req: ChatRequest): string[] => [...req.system.matchAll(/<skill name="([a-z-]+)">/g)].map((m) => m[1])

describe('packs in real requests', () => {
  beforeEach(() => vi.useRealTimers())

  it('check-understanding loads for an explicit practice request and stays for the answers until it is ended', async () => {
    const chat = new RoutingChat()
    const t = sessionWith(chat, { whiteboard: false, lessonSupport: false })
    chat.routes.push('PRACTICE')
    t.ask('Quiz me on DNS')
    await until(() => chat.calls.length === 1)
    expect(loaded(chat.calls[0])).toEqual(['check-understanding'])

    t.ask('It turns the name into an IP address') // an answer: no routing words, the pack stays
    await until(() => chat.calls.length === 2)
    expect(loaded(chat.calls[1])).toEqual(['check-understanding'])

    chat.routes.push('STOP_PRACTICE')
    t.ask("Okay that's enough, let's stop")
    await until(() => chat.calls.length === 3)
    expect(loaded(chat.calls[2])).toEqual([])

    t.ask('What is a variable?')
    await until(() => chat.calls.length === 4)
    expect(loaded(chat.calls[3])).toEqual([])
  })
})

describe('the assembled API request', () => {
  beforeEach(() => vi.useRealTimers())
  afterEach(() => vi.restoreAllMocks())

  /** A stand-in for api.anthropic.com: records each request body and streams back a short reply. */
  function fakeApi(replyFor: (body: { system: string }) => string) {
    const bodies: Array<Record<string, unknown> & { system: string }> = []
    const fetch = async (_url: unknown, init?: { body?: unknown }): Promise<Response> => {
      const body = JSON.parse(String(init?.body))
      bodies.push(body)
      const text = replyFor(body)
      const ev = (name: string, data: unknown): string => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
      const sse =
        ev('message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }) +
        ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
        ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }) +
        ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
        ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }) +
        ev('message_stop', { type: 'message_stop' })
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    return { bodies, fetch }
  }

  it('the HTTP request Claude receives contains exactly the selected packs, after the protocol and with the preferences', async () => {
    const cfg = readVoiceConfig({ ANTHROPIC_API_KEY: 'test-key', DEEPGRAM_API_KEY: 'd', ECHO_WEB_SEARCH: 'off' })
    if (!cfg.ok) throw new Error('config')
    const api = fakeApi((b) => (JSON.stringify(b.system).includes(JSON.stringify(ROUTER_SYSTEM).slice(1, 40)) ? 'DEEP' : '<segment><objective>Hook</objective><say>DNS is the internet phone book.</say></segment>'))
    const client = new Anthropic({ apiKey: 'test-key', maxRetries: 0, fetch: api.fetch as never })
    const chat = new ClaudeChat(cfg.config, client)

    const store = new PreferenceStore('p.json', { read: () => null, write: () => {} })
    store.set('visualStyle', 'minimal sketches', 'explicit')
    const stts: FakeStt[] = []
    const board = new FakeBoard([])
    const session = new VoiceSession({
      config: cfg.config,
      engine,
      chat,
      lesson: { available: () => true, board: () => board },
      preferences: store,
      createStt: (h) => (stts.push(new FakeStt(h)), stts.at(-1)!),
      createTts: (h) => new FakeTts(h),
      emit: () => {},
      log: () => {}
    })
    session.start()
    session.onEngineReady()
    stts[0].hooks.onStatus({ kind: 'connected' })
    stts[0].turn('StartOfTurn', 'Give', 0)
    stts[0].turn('EndOfTurn', 'Give me a deep dive on DNS', 0)

    await until(() => api.bodies.length === 2)
    await sleep(10)
    const [router, tutor] = api.bodies as unknown as Array<Record<string, any>>
    // The routing check is a separate, tiny request: no packs, no caching, no thinking.
    expect(router.system).toEqual([{ type: 'text', text: ROUTER_SYSTEM }])
    expect(router.thinking?.type).not.toBe('adaptive')
    // The tutor request carries both selected packs, verbatim from the files, and not the unselected one, in the
    // cached block; the saved preferences come after the cache breakpoint.
    const [stable, tail] = tutor.system as Array<{ text: string; cache_control?: unknown }>
    expect(stable.cache_control).toEqual({ type: 'ephemeral' })
    expect(stable.text).toContain(SKILLS['visual-teaching'].instructions)
    expect(stable.text).toContain(SKILLS['deep-explanation'].instructions)
    expect(stable.text).not.toContain('<skill name="check-understanding">')
    expect(tail.text).toContain('- Visual style: minimal sketches')
    expect(tail.cache_control).toBeUndefined()
    // Order: core, the lesson protocol, then the packs.
    const at = (s: string): number => stable.text.indexOf(s)
    expect(at('You are ECHO')).toBe(0)
    expect(at('<skill name="visual-teaching">')).toBeGreaterThan(at('LESSON MODE'))
    expect(at('<skill name="deep-explanation">')).toBeGreaterThan(at('<skill name="visual-teaching">'))
    // A deep explanation may think first, at medium effort.
    expect(tutor.thinking).toEqual({ type: 'adaptive' })
    expect(tutor.output_config).toEqual({ effort: 'medium' })
    // Deep explanations go to the deep model with the bigger budget, and the preference tools still ride along.
    expect(tutor.model).toBe(cfg.config.deepModel)
    expect(tutor.max_tokens).toBe(7000)
    expect((tutor.tools as Array<{ name: string }>).map((t) => t.name)).toContain('remember_preference')
  })
})
