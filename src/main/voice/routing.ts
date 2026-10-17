import { asksAboutScreen } from './intent'

// Which model answers a turn that isn't a deep dive. The fast model gives the quickest first word; the strong model
// is worth its extra second or so when the question needs real reasoning, however short it is ("why is my loop off
// by one?"). Decided locally from the words, so ordinary turns pay no extra model call for it.

export type ModelTier = 'fast' | 'strong'

export interface RouteInput {
  question: string
  /** A screenshot goes with this turn. */
  screenShared: boolean
}

export interface ModelRoute {
  tier: ModelTier
  /** Why, for the log. */
  reasons: string[]
}

const SIGNALS: Array<{ name: string; weight: number; re: RegExp }> = [
  { name: 'debugging', weight: 2, re: /\b(?:debug|bug|error|exception|stack ?trace|traceback|crash(?:es|ed|ing)?|doesn'?t work|not working|broken|fail(?:s|ed|ing)?|wrong (?:output|answer|result)|what'?s wrong|off[- ]by[- ]one|infinite loop|keeps (?:returning|printing|giving))\b/i },
  { name: 'own-code', weight: 1, re: /\b(?:my|our) (?:code|loop|function|program|query|script|tests?|app|regex|class|method|solution|answer)\b/i },
  { name: 'comparison', weight: 2, re: /\b(?:trade[- ]?offs?|pros and cons|compare[ds]?|comparison|difference between|differ(?:s|ent from)?|versus|vs\.?|which (?:is|one is) better|should i (?:use|choose|pick|go with))\b/i },
  { name: 'proof', weight: 2, re: /\b(?:prove|proof|derive|derivation|show that|why (?:does|do|is|are|would|can'?t|doesn'?t|isn'?t) .{0,60}\b(?:not|n't|instead|rather|than|always|never)\b)/i },
  { name: 'math', weight: 2, re: /\b(?:solve|equation|integral|derivative|probability|calculate|compute|complexity|big[- ]o)\b|[=^√∑∫]|\d\s*[+*/×^]\s*\d|\d+(?:\.\d+)?\s*(?:percent|%)|\bhow (?:much|many|long)\b.{0,80}\d/i },
  { name: 'design', weight: 2, re: /\b(?:design|architect(?:ure)?|optimi[sz]e|scal(?:e|ing|ability)|best way to|strategy for|how would you (?:build|structure|approach))\b/i },
  { name: 'repair', weight: 2, re: /\b(?:still (?:don'?t|do not) (?:get|understand)|doesn'?t make sense|(?:i'?m|i am) (?:still )?(?:confused|lost)|that'?s (?:wrong|not right|incorrect)|you said .{1,60} but|no,? (?:i meant|that'?s not what))\b/i },
  { name: 'performance', weight: 1, re: /\b(?:slow(?:er)?|faster|performance|memory leak|bottleneck|efficient|efficiency)\b/i },
  { name: 'mechanism', weight: 1, re: /\bhow (?:does|do|is|are|can) .{2,60}\b(?:work|happen|possible)\b|\bwhat happens (?:when|if|under)\b/i },
  { name: 'why', weight: 1, re: /^(?:so |but |and |ok(?:ay)? )?why\b/i }
]

const CODE_OR_MATH_ON_SCREEN = /\b(?:code|function|error|bug|line|output|equation|formula|graph|chart|proof|problem|exercise|question|query|regex)\b/i

export function chooseModelTier(input: RouteInput): ModelRoute {
  const q = input.question.trim()
  const words = q.split(/\s+/).filter(Boolean).length
  const reasons: string[] = []
  let score = 0
  for (const s of SIGNALS) {
    if (s.re.test(q)) {
      score += s.weight
      reasons.push(s.name)
    }
  }
  if ((q.match(/\?/g) ?? []).length >= 2 || /\b(?:and (?:also|then) (?:why|how|what)|as well as why)\b/i.test(q)) {
    score += 1
    reasons.push('multi-part')
  }
  if (words > 30) {
    score += 1
    reasons.push('long')
  }
  // Reading code, an error or an equation off a screenshot is where the stronger model's vision pays off.
  if (input.screenShared && asksAboutScreen(q) && CODE_OR_MATH_ON_SCREEN.test(q)) {
    score += 2
    reasons.push('screen-reasoning')
  }
  // "Why?" or "Thanks, that's wrong" alone is too little to go on; a repair still counts.
  if (words < 4 && !reasons.includes('repair')) return { tier: 'fast', reasons: ['short'] }
  return score >= 2 ? { tier: 'strong', reasons } : { tier: 'fast', reasons: reasons.length ? reasons : ['simple'] }
}

/** Said while the stronger model starts, which takes a moment longer than the fast one. */
export const THINKING_FILLERS = ['Hmm, let me think about that.', 'Good question. Let me think.', 'Okay, let me work through that.', 'Ooh, let me think this one through.']
