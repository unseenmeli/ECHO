export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Conversation history that only records what the user actually heard.
 * - An interrupted reply is stored as just the part that was delivered.
 * - A user turn that was never answered (interrupted before any audio) is
 *   merged with what the user says next, so a premature end-of-turn can't
 *   split one question into two.
 */
export class ConversationHistory {
  private messages: ChatMessage[] = []
  private lastUserUnanswered = false

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

  /** Record the assistant reply the user actually received (may be empty). */
  commitAssistant(delivered: string): void {
    const text = delivered.trim()
    if (!text) return
    this.messages.push({ role: 'assistant', content: text })
    this.lastUserUnanswered = false
  }

  /** ECHO began answering but nothing usable was heard: the question still counts as asked. */
  markAnswered(): void {
    this.lastUserUnanswered = false
  }

  toMessages(limit: number): ChatMessage[] {
    // Merge consecutive same-role messages, then keep the most recent `limit`
    // starting on a user turn.
    const merged: ChatMessage[] = []
    for (const m of this.messages) {
      const prev = merged[merged.length - 1]
      if (prev && prev.role === m.role) prev.content = `${prev.content}\n${m.content}`
      else merged.push({ ...m })
    }
    let out = merged.slice(-limit)
    while (out.length && out[0].role !== 'user') out = out.slice(1)
    return out
  }

  clear(): void {
    this.messages = []
    this.lastUserUnanswered = false
  }
}
