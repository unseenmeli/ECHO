// A second line of defence against ECHO hearing itself. Browser echo
// cancellation does most of the work; this catches what leaks through by
// checking whether a "user" transcript is just ECHO's own recent words.

const COMMAND_WORDS = new Set(['stop', 'wait', 'hold', 'pause', 'enough', 'quiet', 'cancel', 'sorry', 'actually'])
const OVERLAP_RATIO = 0.8
const MEMORY_MS = 12_000

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

export class EchoGuard {
  private recent: { tokens: Set<string>; at: number }[] = []

  /** Record text that ECHO is speaking (or has just spoken). */
  noteSpoken(text: string, now: number): void {
    this.recent.push({ tokens: new Set(tokenize(text)), at: now })
    this.prune(now)
  }

  reset(): void {
    this.recent = []
  }

  private prune(now: number): void {
    this.recent = this.recent.filter((r) => now - r.at <= MEMORY_MS + 60_000).slice(-60)
  }

  /**
   * True when the transcript looks like ECHO's own speech: every (or nearly
   * every) word was recently spoken by ECHO and the user didn't use an
   * explicit command word such as "stop" or "wait".
   */
  isEchoLike(transcript: string, now: number, speakingNow: boolean): boolean {
    const words = tokenize(transcript)
    if (!words.length) return false
    if (words.some((w) => COMMAND_WORDS.has(w))) return false

    const heard = new Set<string>()
    for (const r of this.recent) {
      // While ECHO is talking everything it has queued can be audible; afterwards only a short tail.
      if (speakingNow || now - r.at <= MEMORY_MS) for (const t of r.tokens) heard.add(t)
    }
    if (!heard.size) return false

    const overlap = words.filter((w) => heard.has(w)).length / words.length
    return overlap >= OVERLAP_RATIO
  }
}
