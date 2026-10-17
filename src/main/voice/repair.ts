// Conversation repair: tell the model when the transcript may be wrong, or when "this" may point at nothing it can
// see, so it checks with one short question instead of confidently answering a question the learner didn't ask.
// Notes ride on the turn context only: they never enter the stored history.

/** Below this, a word is reported as possibly misheard. */
export const UNSURE_CONFIDENCE = 0.6
const MAX_UNSURE_WORDS = 4
/** Short function words are misheard often and rarely change the meaning. */
const MINOR = new Set('a an and are as at be but by do for from had has have he her his i if in is it its me my no not of on or our she so than that the them then they this to up us was we were what when who why will with you your'.split(' '))

/** Words the recognizer was unsure of that could change what the learner meant. */
export function unsureWords(words: Array<{ word: string; confidence: number }> | undefined, threshold = UNSURE_CONFIDENCE): string[] {
  if (!words?.length) return []
  const out: string[] = []
  for (const { word, confidence } of words) {
    const w = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    if (confidence >= threshold || w.length < 3 || MINOR.has(w.toLowerCase()) || out.includes(w)) continue
    out.push(w)
    if (out.length >= MAX_UNSURE_WORDS) break
  }
  return out
}

export function misheardNote(words: string[]): string | null {
  if (!words.length) return null
  const list = words.map((w) => `"${w}"`).join(', ')
  return `<speech_recognition>
Speech recognition was unsure of ${words.length === 1 ? 'one word' : 'some words'} in what the learner just said: ${list}. ${words.length === 1 ? 'It' : 'They'} may have been misheard as a similar-sounding word. If a likely mishearing would change your answer (say "cash" where "cache" fits the topic), first check in one short question and wait for the reply. If the meaning is clear from the conversation, answer the most likely meaning without mentioning this.
</speech_recognition>`
}

// "What is this?", "explain that part": a reference that only makes sense with something to look at.
const DEICTIC = /\bwhat(?:'s| is| are| does| do)? (?:this|that|these|those)\b|\b(?:this|that|these|those) (?:one|ones|thing|things|part|bit|error|code|line|word|step|equation|formula|graph|chart|picture|image|page|diagram|example|bit here)\b|\b(?:explain|read|fix|solve|check|look at) (?:this|that|these|those|it)\b/i

export interface ReferenceContext {
  /** A screenshot goes with this turn. */
  screenShared: boolean
  /** The whiteboard is open (its state and selection reach the model). */
  boardOpen: boolean
  /** Earlier turns exist that "this" could refer to. */
  hasHistory: boolean
}

/** A note for a pointing reference ("what is this?") with nothing supplied that it could point at. */
export function danglingReferenceNote(question: string, ctx: ReferenceContext): string | null {
  if (ctx.screenShared || ctx.boardOpen || ctx.hasHistory || !DEICTIC.test(question)) return null
  return `<reference_check>
The learner refers to something ("this", "that") but no screen, whiteboard or earlier conversation was supplied that says what it is. Don't guess: ask in one short question what they mean, or suggest they share their screen.
</reference_check>`
}
