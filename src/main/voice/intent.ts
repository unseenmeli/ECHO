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
// "what's that error?"). Only used to pick the wait line if the answer is slow
// to start, and to route; the screenshot itself is sent either way.
const SCREEN =
  /\b(?:screen|screenshot|monitor|display|window|tab|see|seeing|saw|look|looking|watch|watching|showing|shown|check|glance|peek)\b|\bwhat(?:'s| is| are)? (?:this|that|these|those|it)\b|\bwhat (?:does|do) (?:this|that|these|those)\b|\b(?:right|over) here\b|\b(?:this|these) (?:thing|one|part|bit|error|code|page|line|button|word|picture|image|photo|graph|chart|diagram|slide|table|map|equation|formula|problem|question|exercise|function|output|message|paragraph|sentence)s?\b/i

export function asksAboutScreen(transcript: string): boolean {
  return SCREEN.test(transcript)
}

/**
 * Said only when nothing has been heard for a noticeable moment after the learner finished (never as an opener),
 * so a slow start doesn't sound like a hang. Plain and short, and never the same line twice in a row.
 */
export const WAIT_LINES = {
  picture: ['Finding a picture.', 'Looking for a picture.'],
  whiteboard: ['Getting the whiteboard ready.', 'Setting up the whiteboard.'],
  screen: ['Looking at your screen.', 'Checking your screen.'],
  other: ['One moment.', 'Just a second.']
} as const

// Words that might mean the learner is talking about the lesson window or asking for a real lesson. They never
// decide anything on their own: a turn that matches is put to the model (see ROUTER_SYSTEM), which judges what
// was meant ("close the deep dive" and "explain it as a deep dive" share words and want opposite things).
// Turns that match nothing skip the extra call, so ordinary questions pay no latency for it.
const LESSON_SIGNAL = new RegExp(
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
    String.raw`\bopen (?:the |a )?lesson\b`,
    // Talk about the window itself, which is how it gets closed.
    String.raw`\blessons?\b`,
    String.raw`\b(?:white)?board\b`,
    String.raw`\bwindow\b`
  ].join('|'),
  'i'
)

/** True when the turn is worth a quick model check for a lesson request (open/deepen/close). */
export function couldBeLessonRequest(transcript: string): boolean {
  return LESSON_SIGNAL.test(transcript)
}

// Asking to be quizzed or to practise. Like LESSON_SIGNAL, this only decides whether the model is asked.
const PRACTICE_SIGNAL =
  /\bquiz(?:zes|zing)?\b|\btest (?:me|my)\b|\bpractis(?:e|ing)\b|\bpractic(?:e|ing)\b|\bexercises?\b|\bcheck (?:my|if i|whether i|that i)\b|\bask me (?:a |some |an? \w+ |\w+ )?questions?\b|\bflash ?cards?\b|\bdrill me\b|\bchallenge me\b|\bcheckpoint\b|\bhow well (?:do )?i (?:understand|know)\b/i
// While practice runs, ways of ending it.
const PRACTICE_END_SIGNAL = /\b(?:stop|end|enough|done|finish(?:ed)?|quit|no more|move on|that's it|let'?s stop)\b/i

/** True when the turn is worth a quick model check for starting (or, while practising, ending) a practice activity. */
export function couldBePracticeRequest(transcript: string, practising: boolean): boolean {
  return PRACTICE_SIGNAL.test(transcript) || (practising && PRACTICE_END_SIGNAL.test(transcript))
}

export type LessonAction = 'none' | 'deep_dive' | 'close_lesson' | 'practice' | 'end_practice'

/** The question put to the model for a turn that matched a signal above. One word back keeps it fast. */
export const ROUTER_SYSTEM = `You route one spoken request for ECHO, a voice tutor that can open a lesson window with a whiteboard. Reply with exactly one word:
DEEP: the learner is asking ECHO to teach or explain something in depth: a full lesson, a deep dive, a walkthrough, or to draw it out on the whiteboard.
CLOSE: the learner is telling ECHO to close, hide, dismiss or end the lesson window, whiteboard or deep dive.
PRACTICE: the learner wants to be quizzed, tested, to practise, or to have their understanding checked with questions.
STOP_PRACTICE: a practice activity is running and the learner wants to stop it or move on.
ANSWER: anything else. That includes questions about what a deep dive or a quiz is, remarks that only mention a lesson or the board, subjects like "deep learning", and requests to close something other than ECHO's lesson window.
Judge what the learner means, not which words they used. When unsure, reply ANSWER.`

export function routerPrompt(transcript: string, lessonOpen: boolean, lastEchoLine: string | null, practising = false): string {
  return [
    `Lesson window: ${lessonOpen ? 'open' : 'closed'}`,
    `Practice activity: ${practising ? 'running' : 'none'}`,
    lastEchoLine ? `ECHO's last words: "${lastEchoLine.slice(-240).replace(/"/g, "'")}"` : null,
    `Learner: "${transcript.replace(/"/g, "'")}"`
  ]
    .filter(Boolean)
    .join('\n')
}

/** Reads the model's one-word answer. Null when it said something else. */
export function parseRoute(text: string): LessonAction | null {
  const m = /\b(STOP_PRACTICE|DEEP|CLOSE|PRACTICE|ANSWER)\b/i.exec(text)
  if (!m) return null
  switch (m[1].toUpperCase()) {
    case 'DEEP':
      return 'deep_dive'
    case 'CLOSE':
      return 'close_lesson'
    case 'PRACTICE':
      return 'practice'
    case 'STOP_PRACTICE':
      return 'end_practice'
    default:
      return 'none'
  }
}

// Only used when the model could not be asked in time (offline, timed out): closing the window must still work.
// It can only close, never open or deepen anything.
const CLOSE_FALLBACK =
  /^(?:(?:ok(?:ay)?|alright|please|hey|echo|can you|could you|would you)[\s,]+)*(?:close|dismiss|hide|shut|exit|end|put away|get rid of|minimi[sz]e)\s+(?:down\s+)?(?:the\s+|this\s+|that\s+|your\s+)?(?:deep[-\s]?dive|lesson|white\s?board|board|window)(?:\s+(?:window|please))?[\s,.!]*(?:please|echo)?[\s.!]*$/i

export function closeFallback(transcript: string): LessonAction {
  return CLOSE_FALLBACK.test(transcript.trim()) ? 'close_lesson' : 'none'
}

// Asking to SEE something: "show me a picture of a neuron", "can I see a photo of the Eiffel Tower", "what does
// a pangolin look like". These are fulfilled with a real picture on the whiteboard, never with its name written down.
const PICTURE_NOUN = String.raw`(?:pictures?|photos?|photographs?|images?|pics?)`
const PICTURE_OF = new RegExp(String.raw`\b${PICTURE_NOUN}\s+of\s+(.+)`, 'i')
const PICTURE_VERB = /\b(?:show|see|find|get|pull up|bring up|display|look at|want|give|put|draw|have)\b/i
const LOOKS_LIKE = /\bwhat (?:does|do|did) (.+?) (?:actually |really )?look like\b/i
const SUBJECT_TAIL = /\s*(?:\bplease\b|\bfor me\b|\bon (?:the|your) (?:white)?board\b|\bright now\b|\bthanks?\b|\bthank you\b|[,.!?…]).*$/i

/** What the learner asked to see a picture of, or null when the turn isn't a request to see one. */
export function pictureRequest(transcript: string): string | null {
  const t = transcript.trim()
  const m = (PICTURE_VERB.test(t) && PICTURE_OF.exec(t)) || LOOKS_LIKE.exec(t)
  if (!m) return null
  const subject = m[1]
    .replace(SUBJECT_TAIL, '')
    .replace(/^(?:a|an|the|some|this|that)\s+/i, '')
    .trim()
  const words = subject.split(/\s+/).filter(Boolean)
  if (subject.length < 2 || words.length > 6 || /^(?:it|this|that|these|those|them|one)$/i.test(subject)) return null
  // "The big picture of how inflation works" is about understanding, not seeing.
  if (/^(?:how|what|why|where|when|whether|who)\b/i.test(subject)) return null
  return subject
}

/** A random wait line, never the same one twice in a row. */
export function pickFiller(previous: string | null, random: () => number = Math.random, lines: readonly string[] = WAIT_LINES.other): string {
  const options = lines.filter((f) => f !== previous)
  return options[Math.floor(random() * options.length)] ?? lines[0]
}

/** True when there is nothing to answer: empty, or no letters/digits (e.g. "...", "-"). */
export function isNoise(transcript: string): boolean {
  return !/[\p{L}\p{N}]/u.test(transcript)
}
