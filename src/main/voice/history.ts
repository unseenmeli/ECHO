export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/** Instructions for folding older turns into a running summary (one cheap call, off the reply's critical path). */
export const SUMMARY_SYSTEM = `You keep a running summary of an earlier part of a spoken tutoring conversation between a learner and ECHO, a voice tutor. The tutor reads it instead of those turns, so write it for the tutor, not the learner.
Keep, in under 180 words of plain prose:
- the topics covered and how far each got
- facts, numbers, names and examples that were established
- corrections: what the learner got wrong or corrected, and what ECHO corrected
- what the learner clearly understands, and what they struggled with
- questions that are still open, and anything ECHO promised to come back to
Merge the previous summary with the new turns. Leave out small talk. Never add facts that aren't in the text. Text in square brackets is an app note about delivery (an interruption, sources); keep its meaning, not its wording.`

export function summaryRequest(previous: string | null, turns: ChatMessage[]): string {
  const transcript = turns.map((m) => `${m.role === 'user' ? 'Learner' : 'ECHO'}: ${m.content}`).join('\n')
  return `${previous ? `Previous summary:\n${previous}\n\n` : ''}New turns to fold in:\n${transcript}\n\nWrite the updated summary.`
}

/**
 * Conversation history that only records what the user actually heard.
 * - An interrupted reply is stored as just the part that was delivered, with a note saying it was cut off.
 * - A user turn that was never answered (interrupted before any audio) is
 *   merged with what the user says next, so a premature end-of-turn can't
 *   split one question into two.
 * - Older turns are folded into a summary in chunks, so what is sent stays bounded and, between folds, starts
 *   with the same bytes every turn (which keeps the conversation prefix cacheable).
 * Kept in memory for the session only.
 */
export class ConversationHistory {
  private messages: ChatMessage[] = []
  private lastUserUnanswered = false
  private summary: string | null = null

  addUser(text: string): void {
    this.messages.push({ role: 'user', content: text })
    this.lastUserUnanswered = true
  }

  /** True when the most recent user message got no delivered reply. */
  hasUnansweredUser(): boolean {
    return this.lastUserUnanswered && this.messages[this.messages.length - 1]?.role === 'user'
  }

  mergeIntoLastUser(text: string): void {
    const last = this.messages[this.messages.length - 1]
    if (last?.role === 'user') last.content = `${last.content} ${text}`.trim()
    else this.addUser(text)
    this.lastUserUnanswered = true
  }

  /**
   * Record the assistant reply the user actually received (may be empty).
   * @param note An app note appended in brackets, e.g. that the learner cut the reply off here.
   */
  commitAssistant(delivered: string, note?: string): void {
    const text = delivered.trim()
    if (!text) return
    this.messages.push({ role: 'assistant', content: note ? `${text} ${note}` : text })
    this.lastUserUnanswered = false
  }

  /** ECHO began answering but nothing usable was heard: the question still counts as asked. */
  markAnswered(): void {
    this.lastUserUnanswered = false
  }

  /**
   * What is sent to the model: the summary of folded turns (on the first message) and the turns since. While a fold
   * is pending or failed, at most `2 × limit` turns are sent, newest first, so the request stays bounded regardless.
   */
  toMessages(limit: number): ChatMessage[] {
    // Merge consecutive same-role messages, then start on a user turn.
    const merged: ChatMessage[] = []
    for (const m of this.messages) {
      const prev = merged[merged.length - 1]
      if (prev && prev.role === m.role) prev.content = `${prev.content}\n${m.content}`
      else merged.push({ ...m })
    }
    let out = merged.slice(-limit * 2)
    while (out.length && out[0].role !== 'user') out = out.slice(1)
    if (this.summary && out.length) {
      out = [{ ...out[0], content: `<conversation_summary>\n${this.summary}\n</conversation_summary>\n\n${out[0].content}` }, ...out.slice(1)]
    }
    return out
  }

  /** Once more than `limit` turns are unfolded: the older ones to summarize, keeping the newest half verbatim. */
  foldPlan(limit: number): { upTo: number; turns: ChatMessage[]; previous: string | null } | null {
    if (this.messages.length <= limit) return null
    let upTo = this.messages.length - Math.ceil(limit / 2)
    while (upTo < this.messages.length && this.messages[upTo].role !== 'user') upTo++
    if (upTo <= 0 || upTo >= this.messages.length) return null
    return { upTo, turns: this.messages.slice(0, upTo).map((m) => ({ ...m })), previous: this.summary }
  }

  /** Replaces the first `upTo` turns with `summary`. Newer turns added while it was written are untouched. */
  applyFold(upTo: number, summary: string): void {
    if (upTo <= 0 || upTo > this.messages.length) return
    this.messages = this.messages.slice(upTo)
    this.summary = summary
  }

  clear(): void {
    this.messages = []
    this.lastUserUnanswered = false
    this.summary = null
  }
}
