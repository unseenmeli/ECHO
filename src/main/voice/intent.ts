export type SpokenIntent = 'stop' | 'other'

// "Stop" style requests are handled locally: nothing is sent to Claude, so
// silence is immediate and costs no tokens. Everything else (including
// "continue", "give me an example", "wait, explain that more simply") goes
// to Claude, which sees the conversation so far.
const STOP =
  /^(?:(?:ok(?:ay)?|alright|please|hey|echo)[\s,]+)*(?:stop(?:\s+(?:it|that|talking|please))?|be\s+quiet|quiet|enough|that'?s\s+enough|hold\s+on|wait|pause|never\s*mind|cancel|shush)(?:[\s,]+(?:please|echo))?$/i

export function classifyIntent(transcript: string): SpokenIntent {
  const t = transcript
    .trim()
    .replace(/[.!?,…]+$/g, '')
    .replace(/\s+/g, ' ')
  return STOP.test(t) ? 'stop' : 'other'
}

/** True when there is nothing to answer: empty, or no letters/digits (e.g. "...", "-"). */
export function isNoise(transcript: string): boolean {
  return !/[\p{L}\p{N}]/u.test(transcript)
}
