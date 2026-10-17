import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readVoiceConfig } from '../src/main/voice/config'
import type { ChatPort, ChatRequest, EnginePort, SttHooks, SttPort, TtsHooks, TtsPort, TurnInfo, VoiceContextProvider } from '../src/main/voice/ports'
import { DEEP_FILLERS, SCREEN_FILLERS } from '../src/main/voice/intent'
import { DEEP_DIVE_REQUEST, VoiceSession, type LessonSupport } from '../src/main/voice/session'

const DEEP_MAX = 7000
import type { VoiceEvent } from '../src/shared/voice'
import type { VisualPlan } from '../src/main/lesson/ops'
import { FakeBoard, diagramPlan, sleep, until } from './helpers/lesson-fakes'

// The real VoiceSession in lesson mode, with doubles for Deepgram, Claude, the
// audio engine and the whiteboard. The tutor writes the drawing itself, inside its segments.

class FakeStt implements SttPort {
  closed = false
  constructor(readonly hooks: SttHooks) {}
  connect(): void {}
  sendAudio(): void {}
  forceEndTurn(): void {}
  close(): void {
    this.closed = true
  }
  turn(event: TurnInfo['event'], transcript: string, turnIndex: number): void {
    this.hooks.onTurn({ event, transcript, turnIndex })
  }
}

class FakeTts implements TtsPort {
  spoken: string[] = []
  flushes = 0
  clears = 0
  constructor(
    readonly hooks: TtsHooks,
    private readonly log: string[]
  ) {}
  ensureConnected(): void {}
  begin(): void {
    this.flushes = 0
  }
  speak(text: string): void {
    this.spoken.push(text.trim())
    this.log.push(`tts:${text.trim()}`)
  }
  canFlush(): boolean {
    return true
  }
  flush(): number {
    return this.flushes++
  }
  clear(): void {
    this.clears++
  }
  close(): void {}
}

class FakeEngine implements EnginePort {
  cleared: string[] = []
  done: string[] = []
  start(): void {}
  stop(): void {}
  setMuted(): void {}
  sendAudio(): void {}
  segmentMarker(): void {}
  responseDone(id: string): void {
    this.done.push(id)
  }
  clearPlayback(id: string): void {
    this.cleared.push(id)
  }
  duck(): void {}
}

class FakeChat implements ChatPort {
  calls: ChatRequest[] = []
  scripts: Array<(req: ChatRequest) => Promise<void>> = []
  async stream(req: ChatRequest): Promise<void> {
    this.calls.push(req)
    await this.scripts.shift()?.(req)
  }
}

/** Streams text in small chunks, like a real token stream. */
const stream = (text: string, chunk = 9) => async (req: ChatRequest): Promise<void> => {
  for (let i = 0; i < text.length; i += chunk) {
    if (req.signal.aborted) return
    req.onText(text.slice(i, i + chunk))
    await Promise.resolve()
  }
}

const draw = (plan: VisualPlan): string => `<draw>${JSON.stringify(plan)}</draw>`
const seg = (objective: string, say: string, plan?: VisualPlan | string): string =>
  `<segment><objective>${objective}</objective>${plan ? (typeof plan === 'string' ? plan : draw(plan)) : ''}<say>${say}</say></segment>`
const SEG1 = seg('Show the parts', 'The CPU does the work. It reads from memory. Memory loads from disk.', diagramPlan('d1', [{ sentence: 1, ops: [{ op: 'highlight', targets: ['d1_b'] }] }]))
const SEG2 = seg('Wrap up', 'That loop repeats billions of times a second.', { setup: [], cues: [{ sentence: 0, ops: [{ op: 'highlight', targets: ['d1_c'] }] }] })

function setup(contextProvider?: VoiceContextProvider) {
  const cfg = readVoiceConfig({ ANTHROPIC_API_KEY: 'a', DEEPGRAM_API_KEY: 'd' })
  if (!cfg.ok) throw new Error('config')
  const log: string[] = []
  const board = new FakeBoard(log)
  const chat = new FakeChat()
  const engine = new FakeEngine()
  const events: VoiceEvent[] = []
  const stts: FakeStt[] = []
  const ttss: FakeTts[] = []
  let windowOpen = true
  let boardAttached = true
  const opened: number[] = []
  const lesson: LessonSupport = {
    available: () => windowOpen,
    board: () => (windowOpen && boardAttached ? board : null),
    open: async (timeoutMs) => {
      opened.push(timeoutMs)
      await sleep(5) // the window takes a moment to load
      windowOpen = true
      return true
    }
  }
  const session = new VoiceSession({
    config: cfg.config,
    engine,
    chat,
    lesson,
    contextProvider,
    createStt: (h) => (stts.push(new FakeStt(h)), stts.at(-1)!),
    createTts: (h) => (ttss.push(new FakeTts(h, log)), ttss.at(-1)!),
    emit: (e) => events.push(e),
    log: () => {}
  })
  session.start()
  session.onEngineReady()
  stts[0].hooks.onStatus({ kind: 'connected' })
  const ask = (text: string, idx: number): void => {
    stts[0].turn('StartOfTurn', text.split(' ')[0], idx)
    stts[0].turn('EndOfTurn', text, idx)
  }
  return { session, board, chat, engine, events, stts, ttss, ask, log, opened, closeWindow: () => (windowOpen = false), detachBoard: () => (boardAttached = false), openWindow: () => (windowOpen = true) }
}

describe('lesson mode through the voice session', () => {
  beforeEach(() => {
    // Real timers: the controller uses short real delays.
    vi.useRealTimers()
  })
  afterEach(() => vi.useRealTimers())

  it('opens the whiteboard and teaches a deep dive when asked to go deep', async () => {
    const t = setup()
    t.closeWindow()
    t.chat.scripts.push(stream(SEG1 + SEG2))
    t.ask('Explain CI/CD deeply', 0)

    // The filler starts right away, before the window has even opened.
    expect(DEEP_FILLERS).toContain(t.ttss[0].spoken[0])
    await until(() => t.chat.calls.length === 1)
    expect(t.opened).toHaveLength(1)
    const call = t.chat.calls[0]
    expect(call.system).toContain('LESSON MODE')
    expect(call.system).toContain('DEEP DIVE')
    expect(call.system).toContain('<already_said>')
    expect(call.maxTokens).toBe(DEEP_MAX)
    // The tutor's narration follows the filler.
    await until(() => t.ttss[0].spoken.length >= 4)
    expect(t.ttss[0].spoken.slice(1, 4)).toEqual(['The CPU does the work.', 'It reads from memory.', 'Memory loads from disk.'])
  })

  it('a normal question in an open lesson is not a deep dive', async () => {
    const t = setup()
    t.chat.scripts.push(stream(SEG2))
    t.ask('What is CI/CD?', 0)
    await until(() => t.chat.calls.length === 1)
    expect(t.chat.calls[0].system).toContain('LESSON MODE')
    expect(t.chat.calls[0].system).not.toContain('DEEP DIVE')
    expect(t.opened).toHaveLength(0)
  })

  it('the go-deeper button asks for a deep dive on the last topic', async () => {
    const t = setup()
    expect(t.session.deepDive()).toBe(false) // nothing to go deeper on yet
    t.chat.scripts.push(stream(SEG2), stream(SEG1))
    t.ask('What is a CPU?', 0)
    await until(() => t.chat.calls.length === 1)
    expect(t.session.deepDive()).toBe(true)
    await until(() => t.chat.calls.length === 2)
    expect(t.chat.calls[1].system).toContain('DEEP DIVE')
    expect(t.chat.calls[1].messages.at(-1)!.content).toContain(DEEP_DIVE_REQUEST)
    expect(t.session.getEntries().some((e) => e.role === 'user' && e.text === DEEP_DIVE_REQUEST)).toBe(true)
  })

  it('sees the shared screen during a lesson too', async () => {
    const shot = { mediaType: 'image/jpeg' as const, data: 'AAAA' }
    const t = setup({
      isWatchingScreen: () => true,
      getContext: async () => ({ screen: 'A screenshot is attached.', screenImage: shot })
    })
    t.chat.scripts.push(stream(SEG2))
    t.ask('Can you explain this thing on my screen?', 0)
    await until(() => t.chat.calls.length === 1)

    expect(SCREEN_FILLERS).toContain(t.ttss[0].spoken[0])
    expect(t.chat.calls[0].image).toEqual(shot)
    expect(t.chat.calls[0].system).toContain('<screen_context>')
    expect(t.chat.calls[0].system).toContain('<already_said>')
  })

  it('speaks the tutor narration while its own drawing is applied, in step with playback', async () => {
    const t = setup()
    t.chat.scripts.push(stream(SEG1 + SEG2))
    t.ask('How does a computer work?', 0)
    await until(() => t.ttss[0].spoken.length === 3)

    // The tutor's tags never reach the speech or the transcript; narration does.
    expect(t.ttss[0].spoken).toEqual(['The CPU does the work.', 'It reads from memory.', 'Memory loads from disk.'])
    // The diagram was drawn before the first sentence was handed to TTS.
    expect(t.log.findIndex((l) => l.startsWith('tts:'))).toBeGreaterThan(t.log.findIndex((l) => l.startsWith('apply:')))
    // The second segment is held until the first one's last sentence is playing.
    expect(t.ttss[0].spoken).toHaveLength(3)

    t.session.onPlayback({ kind: 'started', responseId: 'r1', at: 1 })
    t.session.onPlayback({ kind: 'segmentStart', responseId: 'r1', segment: 0, at: Date.now() })
    await sleep(40)
    expect(t.board.batches).toHaveLength(1)
    t.session.onPlayback({ kind: 'segmentStart', responseId: 'r1', segment: 1, at: Date.now() })
    await until(() => t.board.batches.length === 2) // the sentence-1 highlight
    t.session.onPlayback({ kind: 'segmentStart', responseId: 'r1', segment: 2, at: Date.now() })
    await until(() => t.ttss[0].spoken.length === 4)
    expect(t.ttss[0].spoken[3]).toBe('That loop repeats billions of times a second.')

    // Finish playback: highlights are cleaned up and the reply completes.
    for (let i = 0; i < t.ttss[0].flushes; i++) t.ttss[0].hooks.onFlushed('r1', i)
    t.session.onPlayback({ kind: 'segment', responseId: 'r1', segment: 3, at: 2 })
    t.session.onPlayback({ kind: 'ended', responseId: 'r1', at: 3 })
    await until(() => t.board.batches.at(-1)!.remove.some((id) => id.startsWith('echo:hl_')))
    expect(t.session.getSnapshot().state).toBe('listening')
    const entry = t.session.getEntries().find((e) => e.id === 'r1')!
    expect(entry.text).toBe('The CPU does the work. It reads from memory. Memory loads from disk. That loop repeats billions of times a second.')
    expect(entry.text).not.toMatch(/[<>]/)
  })

  it('gives the tutor the board and the lesson state on a follow-up, and extends the existing drawing', async () => {
    const t = setup()
    t.chat.scripts.push(stream(SEG1), stream(seg('Detail', 'Memory is much faster than the disk.', { setup: [{ op: 'add', diagram: 'd1', near: 'd1_b', side: 'below', nodes: [{ id: 'cache', label: 'Cache' }], edges: [{ from: 'd1_b', to: 'cache', label: 'keeps hot data' }] }], cues: [] })))
    t.ask('How does a computer work?', 0)
    await until(() => t.ttss[0].spoken.length === 3)
    for (let i = 0; i < 3; i++) t.session.onPlayback({ kind: 'segmentStart', responseId: 'r1', segment: i, at: Date.now() })
    for (let i = 0; i < 3; i++) t.ttss[0].hooks.onFlushed('r1', i)
    t.session.onPlayback({ kind: 'started', responseId: 'r1', at: 1 })
    t.session.onPlayback({ kind: 'segment', responseId: 'r1', segment: 2, at: 2 })
    t.session.onPlayback({ kind: 'ended', responseId: 'r1', at: 3 })

    // The user selects a node and asks to go deeper.
    t.board.selected = [t.board.elements.find((e) => e.id === 'echo:d1_b')!]
    t.ask('Explain that further', 1)
    await until(() => t.chat.calls.length === 2)
    const last = t.chat.calls[1].messages.at(-1)!.content
    expect(last).toContain('Explain that further')
    expect(last).toContain('<lesson_context>')
    expect(last).toMatch(/diagram id=d1 "Computer"/)
    expect(last).toMatch(/nodes: d1_a \(CPU\), d1_b \(Memory\), d1_c \(Disk\)/) // ids, so the tutor can reference them
    expect(last).toMatch(/The user has selected: lesson rectangle id=d1_b/)
    expect(last).toMatch(/Segments already presented:/)
    expect(t.chat.calls[1].system).toMatch(/LESSON MODE/)

    await until(() => t.board.elements.some((e) => e.id === 'echo:cache'))
    // The old diagram was not rebuilt: its elements are untouched.
    expect(t.board.elements.filter((e) => e.id === 'echo:d1_a')).toHaveLength(1)
  })

  it('interrupting stops speech and pending drawing; nothing stale appears afterwards; continuing resumes from where it stopped', async () => {
    const t = setup()
    const LATE = seg('Wrap up', 'That loop repeats billions of times a second.', { setup: [{ op: 'add', diagram: 'd1', nodes: [{ id: 'late', label: 'Late' }] }], cues: [] })
    t.chat.scripts.push(stream(SEG1 + LATE), stream(seg('Resume', 'Memory loads from disk, so that is the last step.')))
    t.ask('How does a computer work?', 0)
    await until(() => t.ttss[0].spoken.length === 3)
    t.session.onPlayback({ kind: 'started', responseId: 'r1', at: 1 })
    t.session.onPlayback({ kind: 'segmentStart', responseId: 'r1', segment: 0, at: Date.now() })
    t.session.onPlayback({ kind: 'segmentStart', responseId: 'r1', segment: 1, at: Date.now() })

    // The user talks over ECHO while segment 2 is waiting for its turn.
    t.stts[0].turn('StartOfTurn', 'Wait', 1)
    expect(t.engine.cleared).toEqual(['r1'])
    expect(t.ttss[0].clears).toBe(1)
    const batches = t.board.batches.length
    await sleep(150)
    expect(t.board.batches).toHaveLength(batches)
    expect(t.board.elements.some((e) => e.id === 'echo:late')).toBe(false)
    expect(t.ttss[0].spoken).toHaveLength(3) // segment 2 never reached speech
    expect(t.board.elements.some((e) => e.id === 'echo:d1_a')).toBe(true) // what was drawn stays

    t.session.onPlayback({ kind: 'stopped', responseId: 'r1', at: Date.now() })
    t.stts[0].turn('EndOfTurn', 'Continue please', 1)
    await until(() => t.chat.calls.length === 2)
    const ctx = t.chat.calls[1].messages.at(-1)!.content
    expect(ctx).toMatch(/interrupted during s1/)
    // The tutor is told what was already heard so it can continue without repeating it.
    expect(ctx).toMatch(/s1: Show the parts \(heard 2 of 3 sentences\)/)
  })

  it('works verbally, without claiming a drawing, when the lesson window closes during a lesson', async () => {
    const t = setup()
    t.detachBoard() // the window went away after the lesson started
    t.chat.scripts.push(stream(seg('x', 'As you can see, the CPU runs programs. It does that extremely quickly.', diagramPlan('d1'))))
    t.ask('Tell me about CPUs', 0)
    await until(() => t.ttss[0].spoken.length === 2)
    expect(t.ttss[0].spoken[0]).toBe('The CPU runs programs.')
    expect(t.board.batches).toHaveLength(0)
    expect(t.events.some((e) => e.type === 'lesson-status' && e.status.message)).toBe(false)
  })

  it('uses the ordinary voice path (no segment format) when no lesson window is open', async () => {
    const t = setup()
    t.closeWindow()
    t.chat.scripts.push(stream('A plain spoken answer that has two sentences. It is very short.'))
    t.ask('Hello there', 0)
    await until(() => t.chat.calls.length === 1)
    expect(t.chat.calls[0].system).not.toMatch(/LESSON MODE/)
  })

  it('reopening the lesson window does not duplicate sessions: one session, one set of sockets', () => {
    const t = setup()
    t.closeWindow()
    t.openWindow()
    t.session.start() // already active
    expect(t.stts).toHaveLength(1)
    expect(t.ttss).toHaveLength(1)
  })

  it('shows a status when the drawing is unusable, and the voice conversation is unaffected', async () => {
    const t = setup()
    t.chat.scripts.push(stream(seg('Show the parts', 'The CPU does the work. It reads from memory. Memory loads from disk.', '<draw>{this is not json</draw>')))
    t.ask('How does a computer work?', 0)
    await until(() => t.ttss[0].spoken.length === 3)
    expect(t.events.some((e) => e.type === 'lesson-status' && e.status.level === 'warn')).toBe(true)
    expect(t.session.getSnapshot().state).not.toBe('error')
    expect(t.board.batches).toHaveLength(0)
  })
})
