import { describe, expect, it } from 'vitest'
import { danglingReferenceNote, misheardNote, unsureWords } from '../src/main/voice/repair'
import { voiceSession } from './helpers/voice-fakes'

const w = (pairs: Array<[string, number]>) => pairs.map(([word, confidence]) => ({ word, confidence }))
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('conversation repair', () => {
  it('flags only content words heard with low confidence', () => {
    expect(unsureWords(w([['what', 0.2], ['is', 0.3], ['a', 0.1], ['cash', 0.41], ['miss,', 0.5], ['exactly', 0.97]]))).toEqual(['cash', 'miss'])
    expect(unsureWords(undefined)).toEqual([])
    expect(unsureWords(w([['cash', 0.41]]), 0)).toEqual([]) // turned off
  })

  it('asks the model to check only when a mishearing would change the answer', () => {
    const note = misheardNote(['cash'])!
    expect(note).toContain('"cash"')
    expect(note).toMatch(/first check in one short question/)
    expect(note).toMatch(/If the meaning is clear from the conversation, answer the most likely meaning/)
    expect(misheardNote([])).toBeNull()
  })

  it('notices "what is this?" with nothing to point at', () => {
    const none = { screenShared: false, boardOpen: false, hasHistory: false }
    expect(danglingReferenceNote('What is this?', none)).toMatch(/Don't guess/)
    expect(danglingReferenceNote('Can you explain that part?', none)).not.toBeNull()
    expect(danglingReferenceNote('What is this?', { ...none, screenShared: true })).toBeNull()
    expect(danglingReferenceNote('What is this?', { ...none, hasHistory: true })).toBeNull()
    expect(danglingReferenceNote('What is a for loop?', none)).toBeNull()
  })

  it('a turn with unsure words reaches the model with the note, and the note stays out of history', async () => {
    const { chat, stt } = voiceSession()
    stt.turn('StartOfTurn', 'How', 0)
    stt.turn('EndOfTurn', 'How does a CPU cash work?', 0, w([['How', 0.99], ['does', 0.98], ['a', 0.95], ['CPU', 0.93], ['cash', 0.38], ['work', 0.97]]))
    await tick()
    const first = chat.calls.at(-1)!
    expect(first.turnContext).toContain('<speech_recognition>')
    expect(first.turnContext).toContain('"cash"')
    expect(first.messages.at(-1)).toEqual({ role: 'user', content: 'How does a CPU cash work?' })

    stt.turn('StartOfTurn', 'Thanks', 1)
    stt.turn('EndOfTurn', 'Thanks, and what about RAM?', 1, w([['Thanks', 0.99], ['RAM', 0.95]]))
    await tick()
    const second = chat.calls.at(-1)!
    expect(second.turnContext ?? '').not.toContain('speech_recognition')
    expect(JSON.stringify(second.messages)).not.toContain('speech_recognition')
  })

  it('a dangling "this" at the start of a conversation gets the reference check', async () => {
    const { chat, stt } = voiceSession()
    stt.turn('StartOfTurn', 'What', 0)
    stt.turn('EndOfTurn', 'What is this?', 0)
    await tick()
    expect(chat.calls.at(-1)!.turnContext).toContain('<reference_check>')
  })
})
