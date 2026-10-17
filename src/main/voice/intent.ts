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

// Requests for a real lesson rather than a quick answer: these open the whiteboard and switch the tutor to
// deep-dive teaching. Bare "deep" is left out on purpose so "what is deep learning?" stays a normal question.
const DEEP = new RegExp(
  [
    String.raw`\bin[-\s]?depth\b`,
    String.raw`\bdeep(?:er|ly)\b`,
    String.raw`\b(?:go|dive|dig|get) (?:really |super |way )?deep\b`,
    String.raw`\bdeep[-\s]?dive\b`,
    String.raw`\bthorough(?:ly)?\b`,
    String.raw`\bin (?:great |full |more |much more |a lot of )?detail\b`,
    String.raw`\bdetailed\b`,
    String.raw`\bstep[-\s]by[-\s]step\b`,
    String.raw`\bbreak (?:it|this|that|[\w/.-]+) down\b`,
    String.raw`\bwalk me through\b`,
    String.raw`\bteach me\b`,
    String.raw`\b(?:full|whole|proper|complete|real) (?:lesson|explanation|breakdown|picture)\b`,
    String.raw`\bfrom (?:the )?(?:ground up|scratch)\b`,
    String.raw`\beverything (?:about|there is)\b`,
    String.raw`\b(?:go|get) heavy\b`,
    String.raw`\bheavy (?:explanation|lesson|detail|breakdown)\b`,
    String.raw`\bexplain (?:[\w/.-]+ ){0,4}properly\b`,
    String.raw`\b(?:draw|sketch|diagram) (?:it|this|that|me|out)\b`,
    String.raw`\b(?:on|at|to) the (?:white)?board\b`,
    String.raw`\bopen (?:the |a )?lesson\b`
  ].join('|'),
  'i'
)

export function wantsDeepDive(transcript: string): boolean {
  return DEEP.test(transcript)
}

/** Said while the whiteboard opens and the lesson is planned. */
export const DEEP_FILLERS = [
  'Ooh, a deep dive! Let me grab the whiteboard.',
  'Oh, I love this one. Whiteboard time!',
  'Okay, let me get the whiteboard ready, this deserves a proper lesson.',
  "Ooh, let's really dig in. Grabbing my markers!",
  'Alright, rolling up my sleeves. Whiteboard coming up!'
]

/** A random filler line, never the same one twice in a row. */
export function pickFiller(previous: string | null, random: () => number = Math.random, lines: readonly string[] = SCREEN_FILLERS): string {
  const options = lines.filter((f) => f !== previous)
  return options[Math.floor(random() * options.length)] ?? lines[0]
}

/** True when there is nothing to answer: empty, or no letters/digits (e.g. "...", "-"). */
export function isNoise(transcript: string): boolean {
  return !/[\p{L}\p{N}]/u.test(transcript)
}
