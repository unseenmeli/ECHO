import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { ClaudeChat } from '../src/main/voice/claude'
import { readVoiceConfig } from '../src/main/voice/config'
import { chooseModelTier, parseQualityRoutes } from '../src/main/voice/routing'

const tier = (question: string, screenShared = false) => chooseModelTier({ question, screenShared }).tier

describe('model routing', () => {
  it('keeps everyday questions on the fast model', () => {
    for (const q of ['What is a variable?', 'Thanks!', 'How many legs does a spider have?', 'Can you give me an example?', 'What does HTML stand for?', 'Continue', 'Why?', 'Tell me about photosynthesis.']) {
      expect(tier(q), q).toBe('fast')
    }
  })

  it('sends short but hard questions to the strong model', () => {
    for (const q of [
      'Why is my loop off by one?',
      'What is the difference between a process and a thread?',
      'Should I use Postgres or MongoDB for this?',
      'Solve x squared plus 3x = 10',
      'I still don\'t get why recursion terminates.',
      'How would you structure a chat app so it can scale?',
      'Prove that the square root of two is irrational.',
      'Why does this throw a null pointer exception?',
      'Why is my hash map lookup slow?',
      'If I invest 1000 dollars at 5 percent compounded yearly, how much do I have after 10 years?'
    ]) {
      expect(tier(q), q).toBe('strong')
    }
  })

  it('treats code or an equation on a shared screen as reasoning work', () => {
    expect(tier("What's wrong with this code?", false)).toBe('strong') // "what's wrong" alone is debugging
    expect(tier('Can you look at this function?', false)).toBe('fast')
    expect(tier('Can you look at this function on my screen?', true)).toBe('strong')
  })

  it('sends visual analysis, whiteboard lessons, practice and follow-ups to the quality model, as configured', () => {
    const route = (question: string, extra: Partial<Parameters<typeof chooseModelTier>[0]> = {}) => chooseModelTier({ question, screenShared: false, ...extra })
    expect(route('What does this diagram show?', { screenShared: true }).reasons).toEqual(['screen'])
    expect(route('What is a variable?', { lesson: true }).tier).toBe('strong')
    expect(route('I think it is forty two', { practice: true }).tier).toBe('strong')
    expect(route('How does a hash map work?').tier).toBe('strong')
    // A short follow-up continues a hard answer on the same model; small talk does not.
    expect(route('What about that?', { previousTier: 'strong' }).reasons[0]).toBe('follow-up')
    expect(route('Thanks!', { previousTier: 'strong' }).tier).toBe('fast')
    // A short question that stands on its own isn't a follow-up, even right after a deep dive.
    expect(route('What is my name?', { previousTier: 'strong' }).tier).toBe('fast')
    expect(route('Who wrote Hamlet?', { previousTier: 'strong' }).tier).toBe('fast')
    expect(route('And the second one?', { previousTier: 'strong' }).reasons[0]).toBe('follow-up')
    expect(route('Can you give me an example?', { previousTier: 'strong' }).reasons[0]).toBe('follow-up')
    expect(route('What about that?').tier).toBe('fast')
    // Each route can be switched off.
    const routes = parseQualityRoutes('reasoning')
    expect(route('What does this diagram show?', { screenShared: true, routes }).tier).toBe('fast')
    expect(route('Why is my loop off by one?', { routes }).tier).toBe('strong')
    expect(route('Why is my loop off by one?', { routes: parseQualityRoutes('none') }).tier).toBe('fast')
  })

  it('says why, for the log', () => {
    expect(chooseModelTier({ question: 'Compare quicksort and mergesort, and also why is one stable?', screenShared: false }).reasons).toEqual(
      expect.arrayContaining(['comparison', 'multi-part'])
    )
  })

  it('the strong tier reaches the API as the strong model, with thinking kept off for a fast start', async () => {
    const cfg = readVoiceConfig({ ANTHROPIC_API_KEY: 'k', DEEPGRAM_API_KEY: 'd', ECHO_STRONG_MODEL: 'claude-opus-5-5' })
    if (!cfg.ok) throw new Error('config')
    const bodies: Array<Record<string, any>> = []
    const fetch = async (_u: unknown, init?: { body?: unknown }): Promise<Response> => {
      const body = JSON.parse(String(init?.body))
      bodies.push(body)
      const ev = (n: string, d: unknown): string => `event: ${n}\ndata: ${JSON.stringify(d)}\n\n`
      return new Response(
        ev('message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }) +
          ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }) +
          ev('message_stop', { type: 'message_stop' }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      )
    }
    const chat = new ClaudeChat(cfg.config, new Anthropic({ apiKey: 'k', maxRetries: 0, fetch: fetch as never }), () => {})
    await chat.stream({ system: 's', messages: [{ role: 'user', content: 'Why is my loop off by one?' }], tier: 'strong', reasoning: 'off', effort: 'medium', signal: new AbortController().signal, onText: () => {} })
    await chat.stream({ system: 's', messages: [{ role: 'user', content: 'Hi' }], reasoning: 'off', signal: new AbortController().signal, onText: () => {} })
    expect(bodies.map((b) => b.model)).toEqual(['claude-opus-5-5', 'claude-haiku-5-5'])
    expect(bodies[0].output_config).toEqual({ effort: 'medium' })
  })
})
