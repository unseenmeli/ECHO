// Turns Claude's token stream into phrases worth sending to TTS. Tokens are
// never sent individually: text is grouped at sentence/clause boundaries.
//
// Deepgram only synthesizes text on Flush, and allows ~20 flushes per minute,
// so the chunker distinguishes between "send this text" (every sentence) and
// "flush now" (the first phrase for low latency, then groups of sentences).

export interface Phrase {
  text: string
  /** Ask TTS to synthesize everything sent so far. */
  flush: boolean
}

export interface ChunkerOptions {
  /** The first phrase is flushed as soon as a sentence ends past this length… */
  firstMinChars: number
  /** …or at a clause break once it has grown past this length. */
  firstClauseChars: number
  /** Later sentences are grouped until at least this much text is waiting for a flush. */
  groupMinChars: number
  /** Hard cap for one piece of text (the API rejects >2000 chars). */
  maxChars: number
}

// Each flush is voiced as one unit, so its intonation starts fresh. A very short first piece ("Sure.") followed by
// a pause, or small groups later, is what makes speech sound like disconnected sentences. The first piece is a full
// clause or two (~40 chars costs a fraction of a second of generation), later ones are two or three sentences.
export const DEFAULT_CHUNKER: ChunkerOptions = {
  firstMinChars: 40,
  firstClauseChars: 110,
  groupMinChars: 220,
  maxChars: 400
}

const SENTENCE_END = /[.!?…]+["'”’)\]]*(?=\s)/g
const CLAUSE_END = /[,;:—–](?=\s)/g
/** A period after one of these is not the end of a sentence when lowercase text (or a number) follows. */
const ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|vs|etc|approx|ca|cf|dr|mr|mrs|ms|prof|st|no|fig|vol|a\.m|p\.m|u\.s|[a-z])\.$/i
/** Never a sentence end, whatever follows ("e.g. Python" is still mid-sentence). */
const ALWAYS_ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|vs|cf)\.$/i

function isSentenceEnd(buf: string, end: number): boolean {
  const before = buf.slice(Math.max(0, end - 8), end)
  if (!/\.["'”’)\]]*$/.test(before)) return true // ! ? … always end a sentence
  if (ALWAYS_ABBREVIATION.test(before)) return false
  if (!ABBREVIATION.test(before)) return true
  const next = buf.slice(end).trimStart().charAt(0)
  return !!next && /[A-Z"“‘']/.test(next)
}

/**
 * Rewrites written shorthand into what a speaker would say, for the voice only (the transcript keeps the original):
 * abbreviations, symbols, and dashes or brackets, which TTS otherwise reads with no pause or an odd one.
 */
export function normalizeForSpeech(text: string): string {
  return text
    .replace(/(^|[\s(])e\.g\.,?(?=\s|$)/gi, '$1for example,')
    .replace(/(^|[\s(])i\.e\.,?(?=\s|$)/gi, '$1that is,')
    .replace(/(^|\s)etc\.(?=\s|$)/gi, '$1and so on.')
    .replace(/(^|\s)vs\.?(?=\s)/gi, '$1versus')
    .replace(/(\d)\s*[–—-]\s*(\d)/g, '$1 to $2')
    .replace(/(\d)\s*%/g, '$1 percent')
    .replace(/~\s*(?=\d)/g, 'about ')
    .replace(/\s*(?:->|→|⇒|=>)\s*/g, ' to ')
    .replace(/\s+&\s+/g, ' and ')
    .replace(/(\S)\s*[—–]\s*(?=\S)/g, '$1, ')
    .replace(/\s+-\s+/g, ', ')
    .replace(/\s*\(([^()]{1,80})\)/g, ', $1,')
    .replace(/,\s*([.!?;:,])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** Removes formatting that sounds wrong when read aloud. */
export function sanitizeForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/[*_~>|#]+/g, '')
    .replace(/\s+/g, ' ')
}

export class PhraseChunker {
  private buffer = ''
  private pending = 0 // chars sent to TTS but not yet flushed
  private firstDone = false

  constructor(private readonly opts: ChunkerOptions = DEFAULT_CHUNKER) {}

  push(delta: string): Phrase[] {
    this.buffer += delta
    return this.drain(false)
  }

  /** Call once when the model has finished; flushes whatever remains. */
  end(): Phrase[] {
    return this.drain(true)
  }

  private take(end: number): string {
    const raw = this.buffer.slice(0, end)
    this.buffer = this.buffer.slice(end).replace(/^\s+/, '')
    return sanitizeForSpeech(raw).trim()
  }

  private drain(final: boolean): Phrase[] {
    const out: Phrase[] = []
    const emit = (text: string, wantFlush: boolean): void => {
      if (!text) return
      this.pending += text.length
      const flush = wantFlush || this.pending >= this.opts.groupMinChars
      out.push({ text, flush })
      if (flush) this.pending = 0
      this.firstDone = true
    }

    for (;;) {
      const cut = this.findCut()
      if (cut === null) break
      emit(this.take(cut.end), cut.flush)
    }

    if (final) {
      const rest = this.take(this.buffer.length)
      if (rest) emit(rest, true)
      else if (this.pending > 0 && out.length) out[out.length - 1].flush = true
      else if (this.pending > 0) out.push({ text: '', flush: true })
      this.pending = 0
    }
    return out
  }

  private findCut(): { end: number; flush: boolean } | null {
    const buf = this.buffer
    const minLen = this.firstDone ? 1 : this.opts.firstMinChars

    SENTENCE_END.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = SENTENCE_END.exec(buf))) {
      const end = m.index + m[0].length
      if (!isSentenceEnd(buf, end)) continue
      if (sanitizeForSpeech(buf.slice(0, end)).trim().length >= minLen) {
        // The first sentence is flushed at once for low latency; later ones group up.
        return { end, flush: !this.firstDone }
      }
    }

    if (!this.firstDone && buf.length >= this.opts.firstClauseChars) {
      CLAUSE_END.lastIndex = 0
      let last = -1
      while ((m = CLAUSE_END.exec(buf))) {
        if (m.index >= 30) last = m.index + 1
      }
      if (last > 0) return { end: last, flush: true }
    }

    if (buf.length >= this.opts.maxChars) {
      const space = buf.lastIndexOf(' ', this.opts.maxChars)
      return { end: space > 0 ? space : this.opts.maxChars, flush: !this.firstDone }
    }
    return null
  }
}
