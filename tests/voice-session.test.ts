import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readVoiceConfig } from '../src/main/voice/config'
import { ChatError, type ChatPort, type ChatRequest, type EnginePort, type SttHooks, type SttPort, type TtsHooks, type TtsPort, type TurnInfo, type VoiceContextProvider } from '../src/main/voice/ports'
import { WAIT_LINES } from '../src/main/voice/intent'
import { VoiceSession } from '../src/main/voice/session'
import type { VoiceEvent } from '../src/shared/voice'

// Controllable stand-ins for the network and the audio engine. They exist only
// in tests; the session under test is the real one.

class FakeStt implements SttPort {
  audio = 0
  forced = 0
  closed = false
  connected = false
  constructor(readonly hooks: SttHooks) {}
  connect(): void {
    this.connected = true
  }
  sendAudio(): void {
    this.audio += 1
  }
  forceEndTurn(): void {
    this.forced += 1
  }
  close(): void {
    this.closed = true
  }
  status(kind: 'connected'): void {
    this.hooks.onStatus({ kind })
  }
  turn(event: TurnInfo['event'], transcript: string, turnIndex: number): void {
    this.hooks.onTurn({ event, transcript, turnIndex })
  }
}

class FakeTts implements TtsPort {
  spoken: string[] = []
  flushes = 0
  clears = 0
  begins: string[] = []
  closed = false
  private current: string | null = null
  constructor(readonly hooks: TtsHooks) {}
  ensureConnected(): void {}
  begin(id: string): void {
    this.begins.push(id)
    this.current = id
    this.flushes = 0
  }
  speak(text: string): void {
    this.spoken.push(text)
  }
  canFlush(): boolean {
    return true
  }
  flush(): number {
    return this.flushes++
  }
  clear(): void {
    this.clears += 1
    this.current = null
  }
  close(): void {
    this.closed = true
  }
  // Test helpers: pretend Deepgram answered.
  audio(id: string, bytes = 4800): void {
    this.hooks.onAudio(id, Buffer.alloc(bytes))
  }
  flushed(id: string, segment: number): void {
    this.hooks.onFlushed(id, segment)
  }
}

class FakeEngine implements EnginePort {
  started = 0
  stopped = 0
  muted: boolean[] = []
  audio: string[] = []
  markers: Array<[string, number]> = []
  done: string[] = []
  cleared: string[] = []
  ducks: boolean[] = []
  start(muted: boolean): void {
    this.started += 1
    this.muted.push(muted)
  }
  stop(): void {
    this.stopped += 1
  }
  setMuted(m: boolean): void {
    this.muted.push(m)
  }
  sendAudio(id: string): void {
    this.audio.push(id)
  }
  segmentMarker(id: string, seg: number): void {
    this.markers.push([id, seg])
  }
  responseDone(id: string): void {
    this.done.push(id)
  }
  clearPlayback(id: string): void {
    this.cleared.push(id)
  }
  duck(on: boolean): void {
    this.ducks.push(on)
  }
}

/** Claude stand-in whose replies are scripted per call and respect cancellation. */
class FakeChat implements ChatPort {
  calls: ChatRequest[] = []
  scripts: Array<(req: ChatRequest) => Promise<void>> = []
  next(script: (req: ChatRequest) => Promise<void>): void {
    this.scripts.push(script)
  }
  async stream(req: ChatRequest): Promise<void> {
    this.calls.push(req)
    const script = this.scripts.shift()
    if (script) await script(req)
  }
}

const reply = (...deltas: string[]) => async (req: ChatRequest): Promise<void> => {
  for (const d of deltas) {
    if (req.signal.aborted) return
    req.onText(d)
    await Promise.resolve()
  }
}
const never = () => (req: ChatRequest): Promise<void> =>
  new Promise((resolve) => req.signal.addEventListener('abort', () => resolve()))

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function setup(contextProvider?: VoiceContextProvider) {
  const cfg = readVoiceConfig({ ANTHROPIC_API_KEY: 'test-a', DEEPGRAM_API_KEY: 'test-d' })
  if (!cfg.ok) throw new Error('config')
  const engine = new FakeEngine()
  const chat = new FakeChat()
  const events: VoiceEvent[] = []
  const stts: FakeStt[] = []
  const ttss: FakeTts[] = []
  const session = new VoiceSession({
    config: cfg.config,
    engine,
    chat,
    createStt: (h) => {
      const s = new FakeStt(h)
      stts.push(s)
      return s
    },
    createTts: (h) => {
      const t = new FakeTts(h)
      ttss.push(t)
      return t
    },
    emit: (e) => events.push(e),
    contextProvider,
    log: () => {}
  })
  const ready = (): void => {
    session.start()
    session.onEngineReady()
    stts[stts.length - 1].status('connected')
  }
  return { session, engine, chat, events, stts, ttss, ready }
}

const ANSWER = ['A variable is a named box that holds a value. ', 'You can change it later. ', 'That is all there is to it.']

describe('voice session', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('1. a short question produces one spoken answer', async () => {
    const { session, engine, chat, stts, ttss, ready } = setup()
    ready()
    expect(session.getSnapshot().state).toBe('listening')

    chat.next(reply(...ANSWER))
    stts.at(-1)!.turn('StartOfTurn', 'What is', 0)
    expect(session.getSnapshot().state).toBe('user-speaking')
    stts.at(-1)!.turn('Update', 'What is a variable', 0)
    stts.at(-1)!.turn('EndOfTurn', 'What is a variable?', 0)
    await flushMicrotasks()

    const tts = ttss.at(-1)!
    expect(chat.calls).toHaveLength(1)
    expect(chat.calls[0].messages).toEqual([{ role: 'user', content: 'What is a variable?' }])
    expect(tts.begins).toEqual(['r1'])
    expect(tts.spoken.join('')).toContain('A variable is a named box')
    expect(session.getSnapshot().state).toBe('thinking')

    // Audio flows to the engine, and playback completes.
    tts.audio('r1')
    expect(engine.audio).toEqual(['r1'])
    for (let seg = 0; seg < tts.flushes; seg++) tts.flushed('r1', seg)
    expect(engine.done).toEqual(['r1'])
    session.onPlayback({ kind: 'started', responseId: 'r1', at: 1 })
    expect(session.getSnapshot().state).toBe('speaking')
    session.onPlayback({ kind: 'segment', responseId: 'r1', segment: tts.flushes - 1, at: 2 })
    session.onPlayback({ kind: 'ended', responseId: 'r1', at: 3 })
    expect(session.getSnapshot().state).toBe('listening')
    expect(session.getEntries().find((e) => e.id === 'r1')).toMatchObject({ final: true, interrupted: false })
  })

  it('2. a natural pause does not split the question', async () => {
    const { chat, stts, engine, ready } = setup()
    ready()
    chat.next(never()) // first (premature) request never produces audio
    chat.next(reply('Sure, here is how the diagram works. ', 'Start at the left box.'))

    // Flux ends the turn at the pause after "explain".
    stts.at(-1)!.turn('StartOfTurn', 'Can you explain', 0)
    stts.at(-1)!.turn('EndOfTurn', 'Can you explain', 0)
    await flushMicrotasks()
    expect(chat.calls).toHaveLength(1)

    // The user keeps going before ECHO said anything.
    stts.at(-1)!.turn('StartOfTurn', 'how this', 1)
    expect(chat.calls[0].signal.aborted).toBe(true)
    stts.at(-1)!.turn('EndOfTurn', 'how this diagram works?', 1)
    await flushMicrotasks()

    expect(chat.calls).toHaveLength(2)
    expect(chat.calls[1].messages).toEqual([{ role: 'user', content: 'Can you explain how this diagram works?' }])
    expect(engine.audio).toEqual([]) // nothing from the cancelled attempt
  })

  it('3. interrupting stops playback and drops stale audio', async () => {
    const { session, engine, chat, stts, ttss, ready } = setup()
    ready()
    chat.next(reply(...ANSWER))
    stts.at(-1)!.turn('StartOfTurn', 'Explain variables', 0)
    stts.at(-1)!.turn('EndOfTurn', 'Explain variables', 0)
    await flushMicrotasks()
    const tts = ttss.at(-1)!
    tts.audio('r1')
    tts.flushed('r1', 0)
    session.onPlayback({ kind: 'started', responseId: 'r1', at: 1 })
    session.onPlayback({ kind: 'segment', responseId: 'r1', segment: 0, at: 2 })
    expect(session.getSnapshot().state).toBe('speaking')

    chat.next(reply('Sure, simply: it is a labelled box.'))
    session.onVad(true) // local VAD fires first (engine already ducked)
    stts.at(-1)!.turn('StartOfTurn', 'Wait explain that', 1)

    expect(chat.calls[0].signal.aborted).toBe(true)
    expect(tts.clears).toBe(1)
    expect(engine.cleared).toEqual(['r1'])

    // Late audio / acks from the interrupted answer must go nowhere.
    const before = engine.audio.length
    tts.audio('r1')
    tts.flushed('r1', 1)
    expect(engine.audio.length).toBe(before)
    expect(engine.done).not.toContain('r1')

    // Only the segment that finished playing counts as heard.
    stts.at(-1)!.turn('EndOfTurn', 'Wait explain that more simply', 1)
    await flushMicrotasks()
    const second = chat.calls[1].messages
    const assistant = second.find((m) => m.role === 'assistant')
    expect(assistant?.content).toBe('A variable is a named box that holds a value. [cut off here: the learner interrupted]')
    expect(second.at(-1)).toEqual({ role: 'user', content: 'Wait explain that more simply' })
    expect(session.getEntries().find((e) => e.id === 'r1')?.interrupted).toBe(true)

    // The ack for the stop arrives from the engine: latency is measured.
    session.onPlayback({ kind: 'stopped', responseId: 'r1', at: Date.now() + 20 })
  })

  it('3b. an interruption keeps the heard share of the segment that was cut off', async () => {
    const { session, chat, stts, ttss, ready } = setup()
    ready()
    chat.next(reply('One two three four five six seven eight nine ten. ', 'Eleven twelve thirteen fourteen fifteen sixteen seventeen.'))
    stts.at(-1)!.turn('StartOfTurn', 'Count', 0)
    stts.at(-1)!.turn('EndOfTurn', 'Count for me', 0)
    await flushMicrotasks()
    const tts = ttss.at(-1)!
    tts.audio('r1')
    session.onPlayback({ kind: 'started', responseId: 'r1', at: 1 })

    chat.next(reply('Okay.'))
    stts.at(-1)!.turn('StartOfTurn', 'Wait', 1)
    // Engine reports the first segment was 40% played when it was silenced.
    session.onPlayback({ kind: 'stopped', responseId: 'r1', at: Date.now(), partial: { segment: 0, fraction: 0.4 } })
    stts.at(-1)!.turn('EndOfTurn', 'Wait, say it again slowly', 1)
    await flushMicrotasks()

    const msgs = chat.calls[1].messages
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(msgs[1].content).toBe('One two three four [cut off here: the learner interrupted]')
  })

  it('an interruption before anything was heard still counts the question as asked', async () => {
    const { session, chat, stts, ttss, ready } = setup()
    ready()
    chat.next(reply('A long answer that was barely started. ', 'More words follow here.'))
    stts.at(-1)!.turn('StartOfTurn', 'Ask', 0)
    stts.at(-1)!.turn('EndOfTurn', 'First question', 0)
    await flushMicrotasks()
    ttss.at(-1)!.audio('r1')
    session.onPlayback({ kind: 'started', responseId: 'r1', at: 1 })
    chat.next(reply('Fine.'))
    stts.at(-1)!.turn('StartOfTurn', 'Hold on', 1)
    session.onPlayback({ kind: 'stopped', responseId: 'r1', at: Date.now() }) // no measurable progress
    stts.at(-1)!.turn('EndOfTurn', 'Hold on, different question', 1)
    await flushMicrotasks()
    // Both user messages are kept, as two separate turns rather than one glued sentence.
    expect(chat.calls[1].messages).toEqual([{ role: 'user', content: 'First question\nHold on, different question' }])
  })

  it('"stop" silences ECHO without calling Claude', async () => {
    const { session, chat, stts, ttss, ready } = setup()
    ready()
    chat.next(reply(...ANSWER))
    stts.at(-1)!.turn('StartOfTurn', 'Tell me about variables', 0)
    stts.at(-1)!.turn('EndOfTurn', 'Tell me about variables', 0)
    await flushMicrotasks()
    ttss.at(-1)!.audio('r1')
    session.onPlayback({ kind: 'started', responseId: 'r1', at: 1 })

    stts.at(-1)!.turn('StartOfTurn', 'Stop', 1)
    stts.at(-1)!.turn('EndOfTurn', 'Stop.', 1)
    await flushMicrotasks()
    expect(chat.calls).toHaveLength(1)
    expect(session.getSnapshot().state).toBe('listening')
  })

  it('4. ECHO hearing itself is not treated as a user question', async () => {
    const { session, engine, chat, stts, ttss, ready } = setup()
    ready()
    chat.next(reply(...ANSWER))
    stts.at(-1)!.turn('StartOfTurn', 'What is a variable', 0)
    stts.at(-1)!.turn('EndOfTurn', 'What is a variable?', 0)
    await flushMicrotasks()
    ttss.at(-1)!.audio('r1')
    session.onPlayback({ kind: 'started', responseId: 'r1', at: 1 })

    // The mic picks up ECHO's own voice and Flux transcribes it as a "turn".
    stts.at(-1)!.turn('StartOfTurn', 'a variable is a named box', 1)
    expect(engine.cleared).toEqual([]) // no interruption
    stts.at(-1)!.turn('EndOfTurn', 'a variable is a named box that holds a value', 1)
    await flushMicrotasks()

    expect(chat.calls).toHaveLength(1) // not sent to Claude
    expect(session.getEntries().some((e) => e.role === 'user' && e.text.includes('named box'))).toBe(false)
    expect(session.getSnapshot().state).toBe('speaking')
  })

  it('5. follow-up questions keep conversational context', async () => {
    const { session, chat, stts, ttss, ready } = setup()
    ready()
    const finish = async (id: string): Promise<void> => {
      const tts = ttss.at(-1)!
      tts.audio(id)
      for (let s = 0; s < tts.flushes; s++) tts.flushed(id, s)
      session.onPlayback({ kind: 'started', responseId: id, at: 1 })
      session.onPlayback({ kind: 'segment', responseId: id, segment: tts.flushes - 1, at: 2 })
      session.onPlayback({ kind: 'ended', responseId: id, at: 3 })
    }

    chat.next(reply('Paris is the capital of France. ', 'It sits on the Seine.'))
    stts.at(-1)!.turn('StartOfTurn', 'What', 0)
    stts.at(-1)!.turn('EndOfTurn', 'What is the capital of France?', 0)
    await flushMicrotasks()
    await finish('r1')

    chat.next(reply('About two million people live there.'))
    stts.at(-1)!.turn('StartOfTurn', 'How', 1)
    stts.at(-1)!.turn('EndOfTurn', 'How many people live there?', 1)
    await flushMicrotasks()

    expect(chat.calls[1].messages.map((m) => `${m.role}:${m.content}`)).toEqual([
      'user:What is the capital of France?',
      'assistant:Paris is the capital of France. It sits on the Seine.',
      'user:How many people live there?'
    ])
  })

  it('empty periodic Flux updates are not speech: they never interrupt ECHO or show up as a user line', async () => {
    const { session, engine, chat, stts, ttss, ready } = setup()
    ready()
    chat.next(reply(...ANSWER))
    stts.at(-1)!.turn('StartOfTurn', 'Explain', 0)
    stts.at(-1)!.turn('EndOfTurn', 'Explain variables', 0)
    await flushMicrotasks()
    ttss.at(-1)!.audio('r1')
    session.onPlayback({ kind: 'started', responseId: 'r1', at: 1 })
    // Flux keeps sending Update events with no transcript while nobody is talking.
    for (let i = 0; i < 5; i++) stts.at(-1)!.turn('Update', '', 1)
    expect(engine.cleared).toEqual([])
    expect(chat.calls[0].signal.aborted).toBe(false)
    expect(session.getSnapshot().state).toBe('speaking')
    expect(session.getEntries().filter((e) => e.role === 'user')).toHaveLength(1)
  })

  it('a duplicate EndOfTurn is ignored', async () => {
    const { chat, stts, ready } = setup()
    ready()
    chat.next(reply('Hello there, friend. '))
    stts.at(-1)!.turn('StartOfTurn', 'Hello', 0)
    stts.at(-1)!.turn('EndOfTurn', 'Hello there', 0)
    stts.at(-1)!.turn('EndOfTurn', 'Hello there', 0)
    await flushMicrotasks()
    expect(chat.calls).toHaveLength(1)
  })

  it('noise-only turns are ignored', async () => {
    const { chat, stts, ready } = setup()
    ready()
    stts.at(-1)!.turn('StartOfTurn', 'hm', 0)
    stts.at(-1)!.turn('EndOfTurn', '...', 0)
    await flushMicrotasks()
    expect(chat.calls).toHaveLength(0)
  })

  it('6. ending and restarting leaves no duplicate streams or listeners', async () => {
    const { session, engine, stts, ttss, chat, ready } = setup()
    ready()
    session.start() // second start while active is a no-op
    expect(stts).toHaveLength(1)
    expect(engine.started).toBe(1)

    chat.next(never())
    const first = stts[0]
    first.turn('StartOfTurn', 'Hello', 0)
    first.turn('EndOfTurn', 'Hello there', 0)
    await flushMicrotasks()
    session.stop()
    expect(first.closed).toBe(true)
    expect(ttss[0].closed).toBe(true)
    expect(engine.stopped).toBeGreaterThanOrEqual(1)
    expect(chat.calls[0].signal.aborted).toBe(true)
    expect(session.getSnapshot().state).toBe('idle')

    // Events from the dead session's sockets are ignored.
    first.turn('StartOfTurn', 'ghost', 5)
    first.turn('EndOfTurn', 'ghost question', 5)
    await flushMicrotasks()
    expect(chat.calls).toHaveLength(1)
    expect(session.getSnapshot().state).toBe('idle')

    ready()
    expect(stts).toHaveLength(2)
    expect(engine.started).toBe(2)
    expect(session.getSnapshot().state).toBe('listening')
    expect(session.getEntries()).toEqual([]) // fresh conversation
  })

  it('7a. muting is applied to the engine and ends a turn in progress', () => {
    const { session, engine, stts, ready } = setup()
    ready()
    stts.at(-1)!.turn('StartOfTurn', 'hello', 0)
    session.setMuted(true)
    expect(engine.muted.at(-1)).toBe(true)
    expect(stts.at(-1)!.forced).toBe(1)
    session.onVad(true) // ignored while muted
    session.setMuted(false)
    expect(engine.muted.at(-1)).toBe(false)
  })

  it('7b. push-to-talk keeps the mic closed until the button is held', () => {
    const { session, engine, stts, ready } = setup()
    ready()
    session.setPushToTalkMode(true)
    expect(engine.muted.at(-1)).toBe(true)

    session.talk(true)
    expect(engine.muted.at(-1)).toBe(false)
    expect(session.getSnapshot().talking).toBe(true)

    session.talk(false)
    // The mic stays open briefly so the last word is not clipped.
    expect(engine.muted.at(-1)).toBe(false)
    vi.advanceTimersByTime(400)
    expect(engine.muted.at(-1)).toBe(true)
    expect(stts.at(-1)!.forced).toBe(1)
  })

  it('push-to-talk press interrupts ECHO', async () => {
    const { session, engine, chat, stts, ttss, ready } = setup()
    ready()
    session.setPushToTalkMode(true)
    chat.next(reply(...ANSWER))
    stts.at(-1)!.turn('StartOfTurn', 'Hi', 0)
    stts.at(-1)!.turn('EndOfTurn', 'Tell me something', 0)
    await flushMicrotasks()
    ttss.at(-1)!.audio('r1')
    session.talk(true)
    expect(engine.cleared).toEqual(['r1'])
  })

  it('the Stop button interrupts a reply', async () => {
    const { session, engine, chat, stts, ready } = setup()
    ready()
    chat.next(never())
    stts.at(-1)!.turn('StartOfTurn', 'Hi', 0)
    stts.at(-1)!.turn('EndOfTurn', 'Tell me something', 0)
    await flushMicrotasks()
    session.stopResponse()
    expect(engine.cleared).toEqual(['r1'])
    expect(session.getSnapshot().state).toBe('listening')
  })

  it('un-ducks if local VAD fired but speech was never confirmed', async () => {
    const { session, engine, chat, stts, ttss, ready } = setup()
    ready()
    chat.next(reply(...ANSWER))
    stts.at(-1)!.turn('StartOfTurn', 'Hi', 0)
    stts.at(-1)!.turn('EndOfTurn', 'Tell me something', 0)
    await flushMicrotasks()
    ttss.at(-1)!.audio('r1')
    session.onPlayback({ kind: 'started', responseId: 'r1', at: 1 })
    session.onVad(true) // a cough
    vi.advanceTimersByTime(1600)
    expect(engine.ducks.at(-1)).toBe(false)
    expect(engine.cleared).toEqual([])
  })

  it('a rejected Anthropic key ends in an error state, not a silent hang', async () => {
    const { session, chat, stts, engine, ready } = setup()
    ready()
    chat.next(async () => {
      throw new ChatError('auth', 'Anthropic rejected the API key (check ANTHROPIC_API_KEY).')
    })
    stts.at(-1)!.turn('StartOfTurn', 'Hi', 0)
    stts.at(-1)!.turn('EndOfTurn', 'Hello', 0)
    await flushMicrotasks()
    expect(session.getSnapshot().state).toBe('error')
    expect(session.getSnapshot().message).toContain('ANTHROPIC_API_KEY')
    expect(engine.stopped).toBeGreaterThanOrEqual(1) // mic released
  })

  it('a rate limit does not replay the answer', async () => {
    const { session, chat, stts, ready } = setup()
    ready()
    chat.next(async () => {
      throw new ChatError('rate-limit', 'Claude is rate limited right now. Try again in a moment.')
    })
    stts.at(-1)!.turn('StartOfTurn', 'Hi', 0)
    stts.at(-1)!.turn('EndOfTurn', 'Hello', 0)
    await flushMicrotasks()
    expect(chat.calls).toHaveLength(1)
    expect(session.getSnapshot().state).toBe('listening')
    expect(session.getSnapshot().message).toContain('rate limited')
  })

  it('reports microphone permission problems clearly', () => {
    const { session, engine, ready } = setup()
    ready()
    session.onEngineError({ code: 'permission-denied', message: 'Microphone access was denied.' })
    expect(session.getSnapshot()).toMatchObject({ state: 'error', message: 'Microphone access was denied.' })
    expect(engine.stopped).toBeGreaterThanOrEqual(1)
  })

  it('shows reconnecting while speech recognition recovers', () => {
    const { session, stts, ready } = setup()
    ready()
    stts.at(-1)!.hooks.onStatus({ kind: 'reconnecting', attempt: 1 })
    expect(session.getSnapshot().state).toBe('connecting')
    stts.at(-1)!.status('connected')
    expect(session.getSnapshot().state).toBe('listening')
    expect(session.getSnapshot().message).toBeNull()
  })
})

describe('local barge-in', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const speakingSession = async () => {
    const ctx = setup()
    ctx.ready()
    ctx.chat.next(reply(...ANSWER))
    ctx.stts.at(-1)!.turn('StartOfTurn', 'Explain', 0)
    ctx.stts.at(-1)!.turn('EndOfTurn', 'Explain variables', 0)
    await flushMicrotasks()
    ctx.ttss.at(-1)!.audio('r1')
    return ctx
  }

  it('sustained local speech stops ECHO even when Deepgram reports nothing', async () => {
    const { session, engine, chat, ttss } = await speakingSession()
    session.onPlayback({ kind: 'started', responseId: 'r1', at: 1 })
    session.onBargeIn()
    expect(engine.cleared).toEqual(['r1'])
    expect(ttss.at(-1)!.clears).toBe(1)
    expect(chat.calls[0].signal.aborted).toBe(true)
    expect(session.getSnapshot().state).toBe('listening')
  })

  it('is ignored while muted, and before ECHO has started speaking', async () => {
    const a = await speakingSession()
    a.session.onBargeIn() // audio has not started playing yet
    expect(a.engine.cleared).toEqual([])

    const b = await speakingSession()
    b.session.onPlayback({ kind: 'started', responseId: 'r1', at: 1 })
    b.session.setMuted(true)
    b.session.onBargeIn()
    expect(b.engine.cleared).toEqual([])
  })
})

describe('screen context', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const SHOT = { mediaType: 'image/jpeg' as const, data: 'AAAA' }
  const watching = (on = true): VoiceContextProvider => ({
    isWatchingScreen: () => on,
    getContext: async () => (on ? { screen: 'A screenshot is attached.', screenImage: SHOT } : { screen: 'Not sharing.' })
  })
  const ask = async (b: ReturnType<typeof setup>, text: string, index = 0): Promise<void> => {
    b.stts.at(-1)!.turn('StartOfTurn', text, index)
    b.stts.at(-1)!.turn('EndOfTurn', text, index)
    await flushMicrotasks()
  }

  it('shows the sources of a searched answer and remembers which sites it cited for follow-ups', async () => {
    const b = setup(watching(false))
    b.ready()
    b.chat.next(async (req) => {
      await reply('Node 24 is the current LTS release.')(req)
      req.onResult?.({
        model: 'claude-haiku-5-5',
        stopReason: 'end_turn',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, searches: 1 },
        sources: [{ title: 'Node.js releases', url: 'https://nodejs.org/en/about/previous-releases', cited: true }],
        searchErrors: [],
        codeRuns: 0
      })
    })
    await ask(b, 'What is the latest Node LTS?')
    const tts = b.ttss.at(-1)!
    tts.flushed('r1', 0)
    b.session.onPlayback({ kind: 'started', responseId: 'r1', at: 1 })
    b.session.onPlayback({ kind: 'ended', responseId: 'r1', at: 2 })
    const entry = b.session.getEntries().find((e) => e.id === 'r1')!
    expect(entry.sources).toEqual([{ title: 'Node.js releases', url: 'https://nodejs.org/en/about/previous-releases', cited: true }])
    b.chat.next(reply('From the Node.js site.'))
    await ask(b, 'Where is that from?', 1)
    expect(b.chat.calls[1].messages[1].content).toBe('Node 24 is the current LTS release. [sources: nodejs.org]')
    expect(b.chat.calls[1].webSearch).toEqual({ maxUses: 2 })
  })

  it('starts with the answer when it comes quickly, with no announcement first', async () => {
    const b = setup(watching())
    b.ready()
    b.chat.next(reply('It is a login form.'))
    await ask(b, 'Do you see this thing on my screen?')
    vi.advanceTimersByTime(5000)
    expect(b.ttss.at(-1)!.spoken.join('')).toBe('It is a login form. ')
    expect(b.chat.calls[0].image).toEqual(SHOT)
  })

  it('says one brief wait line only after a noticeable silence, then answers', async () => {
    const b = setup(watching())
    b.ready()
    b.chat.next(async (req) => {
      await new Promise((r) => setTimeout(r, 5000)) // a slow first word
      await reply('It is a login form. ', 'The password field is empty.')(req)
    })
    await ask(b, 'Hey, do you see this thing on my screen?')
    const tts = b.ttss.at(-1)!
    // ECHO gets three and a half seconds to start answering before it says anything to fill the silence.
    vi.advanceTimersByTime(3400)
    expect(tts.spoken).toEqual([])
    vi.advanceTimersByTime(200)
    expect(WAIT_LINES.screen).toContain(tts.spoken[0]?.trim())
    expect(tts.flushes).toBe(1)
    vi.advanceTimersByTime(2000)
    await flushMicrotasks()
    expect(tts.spoken.slice(1).join('')).toContain('It is a login form.')

    // The wait line is heard but is not part of the conversation history.
    for (let seg = 0; seg < tts.flushes; seg++) tts.flushed('r1', seg)
    b.session.onPlayback({ kind: 'started', responseId: 'r1', at: 1 })
    b.session.onPlayback({ kind: 'ended', responseId: 'r1', at: 2 })
    b.chat.next(reply('Sure.'))
    await ask(b, 'Thanks', 1)
    expect(b.chat.calls[1].messages[1]).toEqual({ role: 'assistant', content: 'It is a login form. The password field is empty.' })
  })

  it('after six seconds of silence adds that the answer is coming, and keeps both lines out of history', async () => {
    const b = setup(watching())
    b.ready()
    b.chat.next(async (req) => {
      await new Promise((r) => setTimeout(r, 8000)) // a very slow first word
      await reply('It is a login form.')(req)
    })
    await ask(b, 'What is this thing on my screen?')
    const tts = b.ttss.at(-1)!
    vi.advanceTimersByTime(3600)
    expect(tts.spoken.length).toBe(1)
    vi.advanceTimersByTime(2500) // 6.1 s
    expect(WAIT_LINES.longer).toContain(tts.spoken[1]?.trim())
    vi.advanceTimersByTime(2000)
    await flushMicrotasks()
    expect(tts.spoken.slice(2).join('')).toContain('It is a login form.')
    for (let seg = 0; seg < tts.flushes; seg++) tts.flushed('r1', seg)
    b.session.onPlayback({ kind: 'started', responseId: 'r1', at: 1 })
    b.session.onPlayback({ kind: 'ended', responseId: 'r1', at: 2 })
    b.chat.next(reply('Sure.'))
    await ask(b, 'Thanks', 1)
    expect(b.chat.calls[1].messages[1]).toEqual({ role: 'assistant', content: 'It is a login form.' })
  })

  it('attaches the screenshot to every turn, without a filler for other questions', async () => {
    const b = setup(watching())
    b.ready()
    b.chat.next(reply('A variable holds a value.'))
    await ask(b, 'What is a variable?')
    expect(b.ttss.at(-1)!.spoken.join('')).toBe('A variable holds a value. ')
    expect(b.chat.calls[0].image).toEqual(SHOT)
    expect(b.chat.calls[0].turnContext).not.toContain('<already_said>')
  })

  it('no filler or screenshot when the screen is not shared', async () => {
    const b = setup(watching(false))
    b.ready()
    b.chat.next(reply("I can't see your screen yet."))
    await ask(b, 'Can you see my screen?')
    expect(b.ttss.at(-1)!.spoken.join('')).toBe("I can't see your screen yet. ")
    expect(b.chat.calls[0].image).toBeUndefined()
    expect(b.chat.calls[0].turnContext).toContain('Not sharing.')
  })

  it('an interruption during the wait line keeps the question open', async () => {
    const b = setup(watching())
    b.ready()
    b.chat.next(never())
    b.chat.next(reply('That is a for loop.'))
    await ask(b, 'Can you look at')
    vi.advanceTimersByTime(3600) // nothing came back, so the wait line plays
    b.ttss.at(-1)!.audio('r1')
    b.session.onPlayback({ kind: 'started', responseId: 'r1', at: 1 })

    // The user keeps talking over the filler.
    await ask(b, 'this code here?', 1)
    vi.advanceTimersByTime(500)
    expect(b.chat.calls[1].messages).toEqual([{ role: 'user', content: 'Can you look at this code here?' }])
  })
})
