import { describe, expect, it } from 'vitest'
import { composeGuide, ComposeTools, composeTools, type ComposePort } from '../src/main/compose/composeTools'
import { parseDestinations, readVoiceConfig } from '../src/main/voice/config'
import type { ChatPort, ChatRequest, EnginePort, SttHooks, SttPort, TtsHooks, TtsPort, TurnInfo } from '../src/main/voice/ports'
import { VoiceSession } from '../src/main/voice/session'
import { cleanRecipients, composeUrl, parseDraftEdits, type Draft, type DestinationId } from '../src/shared/compose'

const draft = (over: Partial<Draft>): Draft => ({ id: 'd1', destination: 'gmail', to: '', subject: '', body: '', ...over })

function fakePort(destinations: DestinationId[] = ['gmail', 'mail', 'x', 'linkedin']) {
  const shown: Array<Draft | null> = []
  const opened: Draft[] = []
  const port: ComposePort = { destinations, show: (d) => shown.push(d), open: (d) => opened.push(d) }
  return { port, shown, opened }
}

describe('compose URLs', () => {
  it('fills in Gmail compose', () => {
    const url = new URL(composeUrl(draft({ to: 'sam@example.com', subject: 'Running late', body: 'Hi Sam,\n10 minutes & counting' })))
    expect(url.host).toBe('mail.google.com')
    expect(url.searchParams.get('view')).toBe('cm')
    expect(url.searchParams.get('to')).toBe('sam@example.com')
    expect(url.searchParams.get('su')).toBe('Running late')
    expect(url.searchParams.get('body')).toBe('Hi Sam,\n10 minutes & counting')
  })

  it('builds a mailto link with CRLF line breaks', () => {
    const url = composeUrl(draft({ destination: 'mail', to: 'a@b.co, c@d.co', subject: 'Hi there', body: 'one\ntwo' }))
    expect(url).toBe('mailto:a@b.co,c@d.co?subject=Hi%20there&body=one%0D%0Atwo')
  })

  it('fills in the X and LinkedIn post boxes', () => {
    expect(new URL(composeUrl(draft({ destination: 'x', body: 'Shipped! #hackathon' }))).searchParams.get('text')).toBe('Shipped! #hackathon')
    const li = new URL(composeUrl(draft({ destination: 'linkedin', body: 'We won' })))
    expect(li.host).toBe('www.linkedin.com')
    expect(li.searchParams.get('text')).toBe('We won')
  })

  it('keeps only real email addresses as recipients', () => {
    expect(cleanRecipients('sam@example.com; Bob, x@y.io')).toBe('sam@example.com, x@y.io')
    expect(cleanRecipients('Sam')).toBe('')
    expect(cleanRecipients(42)).toBe('')
  })

  it('validates card edits', () => {
    expect(parseDraftEdits({ body: 'new', to: 5 })).toEqual({ body: 'new' })
    expect(parseDraftEdits('nope')).toBeNull()
  })

  it('reads the allowed destinations from the environment', () => {
    expect(parseDestinations(undefined)).toEqual(['gmail', 'mail', 'x', 'linkedin'])
    expect(parseDestinations('X, gmail, facebook')).toEqual(['x', 'gmail'])
    expect(parseDestinations('none')).toEqual([])
  })
})

describe('ComposeTools', () => {
  it('only offers and accepts the allowed destinations', () => {
    expect((composeTools(['gmail', 'x'])[0].input_schema.properties.destination as { enum: string[] }).enum).toEqual(['gmail', 'x'])
    expect(composeGuide(['gmail'])).toContain('Posts: none')
    const { port, shown } = fakePort(['gmail'])
    const tools = new ComposeTools(port)
    expect(tools.handle({ name: 'draft_message', input: { destination: 'x', body: 'hi' } })).toMatch(/isn't allowed/)
    expect(tools.handle({ name: 'draft_message', input: { destination: 'gmail', body: '  ' } })).toMatch(/empty/)
    expect(shown).toEqual([])
  })

  it('shows a draft, drops email fields from posts, and says when the address is missing', () => {
    const { port, shown } = fakePort()
    const tools = new ComposeTools(port)
    expect(tools.handle({ name: 'draft_message', input: { destination: 'gmail', to: 'Sam', subject: 'Late', body: 'Hi' } })).toMatch(/no recipient/)
    expect(shown.at(-1)).toMatchObject({ destination: 'gmail', to: '', subject: 'Late', body: 'Hi' })
    tools.handle({ name: 'draft_message', input: { destination: 'x', to: 'a@b.co', subject: 'S', body: 'Post' } })
    expect(shown.at(-1)).toMatchObject({ destination: 'x', to: '', subject: '', body: 'Post' })
  })

  it('opens only on yes, and uses the edited text', () => {
    const { port, opened, shown } = fakePort()
    const tools = new ComposeTools(port)
    tools.handle({ name: 'draft_message', input: { destination: 'gmail', body: 'Hi' } })
    const id = tools.pending!.id
    tools.edit(id, { to: 'sam@example.com', body: 'Hi Sam' })
    expect(tools.resolveSpoken('make it shorter')).toBeNull()
    expect(tools.pending).not.toBeNull()
    expect(tools.resolveSpoken('Yes, send it.')?.kind).toBe('sent')
    expect(opened).toEqual([expect.objectContaining({ to: 'sam@example.com', body: 'Hi Sam' })])
    expect(shown.at(-1)).toBeNull()
    expect(tools.answer(id, true)).toBeNull() // already settled
  })

  it('cancels on no without opening anything', () => {
    const { port, opened } = fakePort()
    const tools = new ComposeTools(port)
    tools.handle({ name: 'draft_message', input: { destination: 'x', body: 'Post' } })
    expect(tools.resolveSpoken("no, don't send it")?.kind).toBe('cancelled')
    expect(opened).toEqual([])
    expect(tools.pending).toBeNull()
  })
})

// --- In a conversation ------------------------------------------------------------------------------

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
  flush(): number {
    return 0
  }
  clear(): void {}
  close(): void {}
}

const noopEngine: EnginePort = {
  start() {},
  stop() {},
  setMuted() {},
  sendAudio() {},
  segmentMarker() {},
  responseDone() {},
  clearPlayback() {},
  duck() {}
}

class FakeChat implements ChatPort {
  calls: ChatRequest[] = []
  scripts: Array<(req: ChatRequest) => void> = []
  async stream(req: ChatRequest): Promise<void> {
    this.calls.push(req)
    this.scripts.shift()?.(req)
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

function setup() {
  const cfg = readVoiceConfig({ ANTHROPIC_API_KEY: 'a', DEEPGRAM_API_KEY: 'd' })
  if (!cfg.ok) throw new Error('config')
  const chat = new FakeChat()
  const stts: FakeStt[] = []
  const ttss: FakeTts[] = []
  const fake = fakePort()
  const session = new VoiceSession({
    config: cfg.config,
    engine: noopEngine,
    chat,
    createStt: (h) => (stts.push(new FakeStt(h)), stts.at(-1)!),
    createTts: (h) => (ttss.push(new FakeTts(h)), ttss.at(-1)!),
    emit: () => {},
    log: () => {},
    compose: fake.port
  })
  session.start()
  session.onEngineReady()
  stts[0].hooks.onStatus({ kind: 'connected' })
  let n = 0
  const say = async (text: string): Promise<void> => {
    stts[0].turn('StartOfTurn', text.split(' ')[0], n)
    stts[0].turn('EndOfTurn', text, n)
    n += 1
    await flush()
  }
  const drafts = (body = 'Hi Sam, running ten minutes late.'): void => {
    chat.scripts.push((r) => {
      r.onToolUse?.({ name: 'draft_message', input: { destination: 'gmail', to: 'sam@example.com', subject: 'Running late', body } })
      // (Worded unlike the user's answer: while a reply is still playing, the echo guard drops words ECHO itself said.)
      r.onText('I wrote Sam a short note saying you are running late. Want me to go ahead?')
    })
  }
  return { session, chat, ttss, say, drafts, ...fake }
}

describe('drafting in a conversation', () => {
  it('offers the drafting tool and its rules with every request', async () => {
    const t = setup()
    t.chat.scripts.push((r) => r.onText('Sure.'))
    await t.say('What is a variable?')
    expect(t.chat.calls[0].tools?.map((x) => x.name)).toEqual(['draft_message'])
    expect(t.chat.calls[0].system).toContain('WRITING EMAILS AND POSTS')
  })

  it('shows the draft, then opens Gmail on a spoken yes without another model call', async () => {
    const t = setup()
    t.drafts()
    await t.say('Write an email to sam@example.com saying I am running late')
    expect(t.shown.at(-1)).toMatchObject({ to: 'sam@example.com', subject: 'Running late' })
    await t.say('send it')
    expect(t.opened).toHaveLength(1)
    expect(t.chat.calls).toHaveLength(1)
    expect(t.ttss[0].spoken.join(' ')).toMatch(/opened Gmail/)
  })

  it('a revision request goes to the model with the draft on screen', async () => {
    const t = setup()
    t.drafts()
    await t.say('Write an email to Sam saying I am late')
    t.drafts('Sam, ten minutes late. Sorry!')
    await t.say('make it shorter')
    expect(t.chat.calls).toHaveLength(2)
    expect(t.chat.calls[1].turnContext).toContain('<pending_draft destination="Gmail">')
    expect(t.shown.at(-1)).toMatchObject({ body: 'Sam, ten minutes late. Sorry!' })
    expect(t.opened).toHaveLength(0)
  })

  it('the card buttons send or cancel, and ECHO says which', async () => {
    const t = setup()
    t.drafts()
    await t.say('Write an email to Sam saying I am late')
    t.session.answerDraft(t.shown.at(-1)!.id, false)
    await flush()
    expect(t.opened).toHaveLength(0)
    expect(t.ttss[0].spoken.join(' ')).toMatch(/won't send it/)
    expect(t.shown.at(-1)).toBeNull()
  })

  it('ending the conversation hides the card', async () => {
    const t = setup()
    t.drafts()
    await t.say('Write an email to Sam saying I am late')
    t.session.stop()
    expect(t.shown.at(-1)).toBeNull()
  })
})
