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

export const DEFAULT_CHUNKER: ChunkerOptions = {
  firstMinChars: 18,
  firstClauseChars: 70,
  groupMinChars: 140,
  maxChars: 400
}

const SENTENCE_END = /[.!?…]+["'”’)\]]*(?=\s)/g
const CLAUSE_END = /[,;:—–](?=\s)/g

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
