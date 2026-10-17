import { describe, expect, it } from 'vitest'
import { normalizeForSpeech, PhraseChunker, sanitizeForSpeech } from '../src/main/voice/chunker'
import { EchoGuard } from '../src/main/voice/echoGuard'
import { ConversationHistory } from '../src/main/voice/history'
import {
  asksAboutScreen,
  classifyIntent,
  closeFallback,
  couldBeLessonRequest,
  DEEP_FILLERS,
  isNoise,
  parseRoute,
  pickFiller,
  SCREEN_FILLERS
} from '../src/main/voice/intent'
import { buildSystemPrompt, buildTurnContext, TUTOR_SYSTEM_PROMPT, withImage } from '../src/main/voice/claude'
import { readVoiceConfig } from '../src/main/voice/config'
import { parseVoiceCommand } from '../src/shared/voice'

describe('PhraseChunker', () => {
  it('flushes the first sentence immediately and groups later ones', () => {
    const c = new PhraseChunker()
    const out = [
      ...c.push('A variable is a named box that holds a value. '),
      ...c.push('You can change what is inside it later. '),
      ...c.push('For example, age can be ten today. '),
      ...c.push('And eleven next year, which is fine. '),
      ...c.end()
    ]
    expect(out[0]).toEqual({ text: 'A variable is a named box that holds a value.', flush: true })
    // Later sentences are sent but flushed in groups, not one by one.
    const flushes = out.filter((p) => p.flush).length
    expect(flushes).toBeLessThan(out.length)
    expect(out[out.length - 1].flush).toBe(true)
    expect(out.map((p) => p.text).join(' ')).toContain('eleven next year')
  })

  it('never emits single tokens', () => {
    const c = new PhraseChunker()
    const emitted: string[] = []
    for (const tok of ['Hel', 'lo', ' there', ',', ' friend', '. ', 'How', ' are', ' you', '?']) {
      emitted.push(...c.push(tok).map((p) => p.text))
    }
    emitted.push(...c.end().map((p) => p.text))
    expect(emitted.every((t) => t.length > 5)).toBe(true)
  })

  it('does not split decimals or abbreviations mid-number', () => {
    const c = new PhraseChunker()
    const out = [...c.push('Pi is about 3.14 and that is enough for most things. '), ...c.end()]
    expect(out[0].text).toContain('3.14')
  })

  it('splits a long first sentence at a clause break so speech can start early', () => {
    const c = new PhraseChunker()
    const out = c.push(
      'Because the function returns a value every time it is called, you can store that result in a variable and reuse it'
    )
    expect(out[0].flush).toBe(true)
    expect(out[0].text.endsWith(',')).toBe(true)
  })

  it('strips markdown that sounds wrong when spoken', () => {
    expect(sanitizeForSpeech('## Title\n- **bold** item with `code` and [a link](http://x.y)')).toBe(
      'Title bold item with code and a link'
    )
  })

  it('emits nothing for an empty response', () => {
    expect(new PhraseChunker().end()).toEqual([])
  })

  it('does not voice a very short opener on its own', () => {
    const c = new PhraseChunker()
    const out = [...c.push('Sure. '), ...c.push('A loop repeats a block of code until a condition is met. '), ...c.end()]
    expect(out[0]).toEqual({ text: 'Sure. A loop repeats a block of code until a condition is met.', flush: true })
  })

  it('never ends a sentence at e.g., i.e. or an abbreviation followed by lowercase', () => {
    const c = new PhraseChunker()
    const out = [...c.push('Some languages, e.g. Python and Ruby, are interpreted at runtime by default. '), ...c.push('approx. ten times slower. '), ...c.end()]
    expect(out[0].text).toBe('Some languages, e.g. Python and Ruby, are interpreted at runtime by default.')
    const d = new PhraseChunker()
    const out2 = [...d.push('It takes approx. ten seconds to warm up the whole cache layer. '), ...d.end()]
    expect(out2[0].text).toBe('It takes approx. ten seconds to warm up the whole cache layer.')
  })

  it('groups later sentences into larger units so intonation flows', () => {
    const c = new PhraseChunker()
    const sentences = Array.from({ length: 8 }, (_, i) => `This is sentence number ${i + 1} of the explanation. `)
    const out = [...sentences.flatMap((t) => c.push(t)), ...c.end()]
    // 8 sentences of ~45 chars: the first piece, then groups of about five, never one flush per sentence.
    expect(out.filter((p) => p.flush).length).toBeLessThanOrEqual(3)
  })
})

describe('normalizeForSpeech', () => {
  it('says shorthand the way a speaker would', () => {
    expect(normalizeForSpeech('Use a list, e.g. [1, 2], i.e. ordered data.')).toBe('Use a list, for example, [1, 2], that is, ordered data.')
    expect(normalizeForSpeech('Speed rose ~40% in 2019–2021 vs. before.')).toBe('Speed rose about 40 percent in 2019 to 2021 versus before.')
    expect(normalizeForSpeech('Input → output & logs')).toBe('Input to output and logs')
  })

  it('turns dashes and brackets into spoken pauses', () => {
    expect(normalizeForSpeech('The CPU (the processor) runs code — fast.')).toBe('The CPU, the processor, runs code, fast.')
    expect(normalizeForSpeech('It is cheap - but slow.')).toBe('It is cheap, but slow.')
    expect(normalizeForSpeech('A well-known self-taught coder')).toBe('A well-known self-taught coder')
  })
})

describe('EchoGuard', () => {
  it("recognizes ECHO's own words but lets command words through", () => {
    const g = new EchoGuard()
    g.noteSpoken('A variable stores a value in memory.', 1000)
    expect(g.isEchoLike('a variable stores a value', 2000, true)).toBe(true)
    expect(g.isEchoLike('wait', 2000, true)).toBe(false)
    expect(g.isEchoLike('can you explain how this diagram works', 2000, true)).toBe(false)
    expect(g.isEchoLike('', 2000, true)).toBe(false)
  })

  it('forgets old speech once ECHO has been quiet for a while', () => {
    const g = new EchoGuard()
    g.noteSpoken('A variable stores a value in memory.', 1000)
    expect(g.isEchoLike('variable stores value', 60_000, false)).toBe(false)
  })
})

describe('intent', () => {
  it('treats stop-style phrases as local stop commands', () => {
    for (const t of ['Stop.', 'stop it', 'Okay, stop.', 'be quiet', 'Hold on', 'wait', "That's enough"]) {
      expect(classifyIntent(t)).toBe('stop')
    }
  })
  it('leaves real requests for Claude', () => {
    for (const t of ['Wait, explain that more simply.', 'Give me an example.', 'Continue.', 'Stop using jargon please']) {
      expect(classifyIntent(t)).toBe('other')
    }
  })
  it('detects noise-only transcripts', () => {
    expect(isNoise('')).toBe(true)
    expect(isNoise(' ... ')).toBe(true)
    expect(isNoise('hm')).toBe(false)
  })
  it('recognizes questions about the screen', () => {
    for (const t of ['Hey, do you see this thing on my screen?', "What's this?", 'Can you look at my code?', 'what is that error', 'this button here']) {
      expect(asksAboutScreen(t)).toBe(true)
    }
    for (const t of ['What is a variable?', 'Explain recursion more simply.', 'Give me an example.']) {
      expect(asksAboutScreen(t)).toBe(false)
    }
  })
  it('flags turns that might be about the lesson window, without deciding anything', () => {
    for (const t of [
      'Explain CI/CD deeply',
      'Can you go in depth on recursion?',
      'go deeper',
      'Give me a deep dive into DNS',
      'close the deep dive',
      'close the whiteboard',
      'hide this window',
      'Explain it properly',
      'walk me through how TLS works',
      'draw it on the board'
    ]) {
      expect(couldBeLessonRequest(t), t).toBe(true)
    }
    for (const t of ['What is deep learning?', 'What is CI/CD?', 'Thanks!', 'What is a variable?']) {
      expect(couldBeLessonRequest(t), t).toBe(false)
    }
  })
  it('reads the routing model one-word answer', () => {
    expect(parseRoute('DEEP')).toBe('deep_dive')
    expect(parseRoute(' close.')).toBe('close_lesson')
    expect(parseRoute('Answer')).toBe('none')
    expect(parseRoute('I am not sure')).toBeNull()
    expect(parseRoute('')).toBeNull()
  })
  it('the offline fallback can only close the lesson window, never open or deepen it', () => {
    for (const t of ['close the deep dive', 'Close the whiteboard.', 'please close the lesson window', 'hide the board', 'ok shut the window']) {
      expect(closeFallback(t), t).toBe('close_lesson')
    }
    for (const t of ['give me a deep dive on DNS', 'what is a deep dive?', 'close the browser tab', 'explain it in depth', 'go deeper']) {
      expect(closeFallback(t), t).toBe('none')
    }
  })
  it('picks fillers from the list it is given', () => {
    expect(DEEP_FILLERS).toContain(pickFiller(null, Math.random, DEEP_FILLERS))
  })
  it('never picks the same filler twice in a row', () => {
    let prev: string | null = null
    for (let i = 0; i < 50; i++) {
      const next = pickFiller(prev)
      expect(SCREEN_FILLERS).toContain(next)
      expect(next).not.toBe(prev)
      prev = next
    }
  })
})

describe('screen context for Claude', () => {
  const image = { mediaType: 'image/jpeg' as const, data: 'AAAA' }

  it('puts the screenshot before the latest user message only', () => {
    const messages = [
      { role: 'user' as const, content: 'Hi' },
      { role: 'assistant' as const, content: 'Hello!' },
      { role: 'user' as const, content: 'What is on my screen?' }
    ]
    const out = withImage(messages, image)
    expect(out.slice(0, 2)).toEqual(messages.slice(0, 2))
    expect(out[2]).toEqual({
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
        { type: 'text', text: 'What is on my screen?' }
      ]
    })
    expect(withImage(messages)).toEqual(messages)
  })
  it('tells Claude what it already said', () => {
    expect(buildSystemPrompt()).toBe(TUTOR_SYSTEM_PROMPT)
    const prompt = buildTurnContext({ screen: 'A screenshot is attached.' }, 'Looking into it!')
    expect(prompt).toContain('<screen_context>\nA screenshot is attached.\n</screen_context>')
    expect(prompt).toContain('<already_said>\nLooking into it!\n</already_said>')
  })
})

describe('ConversationHistory', () => {
  it('stores only what was delivered and merges unanswered questions', () => {
    const h = new ConversationHistory()
    h.addUser('Can you explain')
    expect(h.hasUnansweredUser()).toBe(true)
    h.mergeIntoLastUser('how this works?')
    expect(h.toMessages(10)).toEqual([{ role: 'user', content: 'Can you explain how this works?' }])
    h.commitAssistant('It works like this.')
    expect(h.hasUnansweredUser()).toBe(false)
    h.addUser('And then?')
    h.commitAssistant('') // nothing delivered
    expect(h.hasUnansweredUser()).toBe(true)
    const msgs = h.toMessages(10)
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
  })

  it('always starts the window on a user turn', () => {
    const h = new ConversationHistory()
    h.addUser('one')
    h.commitAssistant('a')
    h.addUser('two')
    h.commitAssistant('b')
    expect(h.toMessages(3)[0].role).toBe('user')
  })

  it('stays bounded: older turns fold into a summary, newer ones stay verbatim', () => {
    const h = new ConversationHistory()
    for (let i = 0; i < 30; i++) {
      h.addUser(`q${i}`)
      h.commitAssistant(`a${i}`)
    }
    expect(h.toMessages(10).length).toBeLessThanOrEqual(20) // capped even before any summary exists
    const plan = h.foldPlan(10)!
    expect(plan.turns[0].content).toBe('q0')
    h.addUser('q30') // a turn arriving while the summary is being written is kept
    h.applyFold(plan.upTo, 'Covered q0 to q27.')
    const msgs = h.toMessages(10)
    expect(msgs[0].content).toBe('<conversation_summary>\nCovered q0 to q27.\n</conversation_summary>\n\nq28')
    expect(msgs.at(-1)!.content).toBe('q30')
    // Between folds the start of what is sent doesn't change, so it can be read from cache.
    h.commitAssistant('a30')
    h.addUser('q31')
    expect(h.toMessages(10)[0]).toEqual(msgs[0])
  })
})

describe('readVoiceConfig', () => {
  it('reports missing credentials without echoing any value', () => {
    const r = readVoiceConfig({})
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.message).toContain('ANTHROPIC_API_KEY')
      expect(r.message).toContain('DEEPGRAM_API_KEY')
    }
  })

  it('applies defaults and clamps tunables', () => {
    const r = readVoiceConfig({
      ANTHROPIC_API_KEY: 'a',
      DEEPGRAM_API_KEY: 'd',
      ECHO_EOT_THRESHOLD: '5',
      ECHO_TTS_VOICE: 'aura-2-helena-en'
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.config.claudeModel).toBe('claude-haiku-5-5')
      expect(r.config.eotThreshold).toBe(1)
      expect(r.config.ttsVoice).toBe('aura-2-helena-en')
      expect(r.config.eagerEotThreshold).toBeNull()
    }
  })
})

describe('parseVoiceCommand', () => {
  it('accepts valid commands and rejects junk', () => {
    expect(parseVoiceCommand({ type: 'mute', muted: true })).toEqual({ type: 'mute', muted: true })
    expect(parseVoiceCommand({ type: 'mute', muted: 'yes' })).toBeNull()
    expect(parseVoiceCommand({ type: 'rm -rf' })).toBeNull()
    expect(parseVoiceCommand(null)).toBeNull()
  })
})

import { BargeInDetector, DEFAULT_BARGE_IN } from '../src/renderer/src/voice/engine/bargeIn'

describe('BargeInDetector', () => {
  const make = (needMs = 450) => new BargeInDetector({ ...DEFAULT_BARGE_IN, needMs })
  const run = (d: BargeInDetector, pattern: number[]): boolean => {
    let t = 0
    for (const p of pattern) {
      t += 32
      if (d.feed(p, t)) return true
    }
    return false
  }

  it('ignores short blips such as a cough or a click', () => {
    expect(run(make(), [0, 0.9, 0.9, 0.9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toBe(false)
  })

  it('ignores quiet leakage that never crosses the speech threshold', () => {
    expect(run(make(), Array(80).fill(0.45))).toBe(false)
  })

  it('triggers on sustained speech', () => {
    expect(run(make(), Array(20).fill(0.9))).toBe(true)
  })

  it('tolerates small gaps between words', () => {
    const word = [...Array(6).fill(0.9), ...Array(3).fill(0.1)]
    expect(run(make(), [...word, ...word, ...word])).toBe(true)
  })

  it('can be disabled', () => {
    expect(run(make(0), Array(100).fill(0.99))).toBe(false)
  })
})
