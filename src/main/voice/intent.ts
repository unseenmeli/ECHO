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

// Questions that probably refer to what's on screen ("do you see this?",
// "what's that error?"). Only used to decide whether ECHO says a filler line
// while the screenshot is taken; the screenshot itself is sent either way.
const SCREEN =
  /\b(?:screen|monitor|display|window|tab|see|seeing|saw|look|looking|watch|watching|showing|shown|check|glance|peek)\b|\bwhat(?:'s| is| are)? (?:this|that|these|those|it)\b|\b(?:right|over) here\b|\bthis (?:thing|one|part|bit|error|code|page|line|button|word|picture|image|graph|chart|equation|formula)\b/i

export function asksAboutScreen(transcript: string): boolean {
  return SCREEN.test(transcript)
}

/** Said right away so the user knows ECHO is looking, not stuck. */
export const SCREEN_FILLERS = [
  'Ooh, let me take a look!',
  'One sec, sitting up in my chair.',
  'Looking into it!',
  'Hang on, let me peek at your screen.',
  'Ooh, okay, give me a second to look.',
  'Let me squint at that for a moment.'
]

/** A random filler line, never the same one twice in a row. */
export function pickFiller(previous: string | null, random: () => number = Math.random): string {
  const options = SCREEN_FILLERS.filter((f) => f !== previous)
  return options[Math.floor(random() * options.length)] ?? SCREEN_FILLERS[0]
}

/** True when there is nothing to answer: empty, or no letters/digits (e.g. "...", "-"). */
export function isNoise(transcript: string): boolean {
  return !/[\p{L}\p{N}]/u.test(transcript)
}
