import { asksAboutScreen } from './intent'

// Which model answers a turn that isn't a deep dive. Quality first: the strong model answers anything that needs real
// reasoning, reads the shared screen, teaches on the whiteboard or checks the learner's answers, however short the
// question ("why is my loop off by one?"). Simple conversation stays on the fast model, whose first word arrives
// soonest. Decided locally, so ordinary turns pay no extra model call for it.

export type ModelTier = 'fast' | 'strong'

/** The kinds of turn that can be sent to the strong model. Each can be switched off (ECHO_QUALITY_ROUTES). */
export const QUALITY_ROUTES = ['reasoning', 'screen', 'lesson', 'practice', 'follow-up'] as const
export type QualityRoute = (typeof QUALITY_ROUTES)[number]

export interface RouteInput {
  question: string
  /** A screenshot goes with this turn. */
  screenShared: boolean
  /** The answer is taught on the open whiteboard (narration and drawing written together). */
  lesson?: boolean
  /** A practice activity is running, so this turn is probably an answer to check. */
  practice?: boolean
  /** The tier that answered the previous turn. */
  previousTier?: ModelTier
  /** Which routes are on. Absent: all of them. */
  routes?: ReadonlySet<QualityRoute>
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
  // Asking for an explanation of how something works is teaching, not chat.
  { name: 'explain', weight: 2, re: /\b(?:explain|walk me through|help me understand|break (?:it|this|that) down)\b/i },
  { name: 'mechanism', weight: 2, re: /\bhow (?:does|do|is|are|can) .{2,60}\b(?:work|happen|possible)\b|\bwhat happens (?:when|if|under)\b/i },
  { name: 'performance', weight: 1, re: /\b(?:slow(?:er)?|faster|performance|memory leak|bottleneck|efficient|efficiency)\b/i },
  { name: 'why', weight: 1, re: /^(?:so |but |and |ok(?:ay)? )?why\b/i }
]

/**
 * Words that tie a short turn to the answer before it ("why?", "what about that?", "give me an example", "and the
 * second one?"). Without one, a short question stands on its own ("what is my name?") and is routed on its own merits.
 */
const CONTINUES = /\b(?:that|this|it|its|those|these|them|they|one|ones|why|how come|what about|and (?:what|how|why|the)|example|another|more|again|simpler|deeper|further|instead|then|so|same|other|second|first|last|next|step|part)\b/i

/** Small talk that never needs the strong model, even right after a hard answer. */
const PLEASANTRY = /^(?:thanks?|thank you|ok(?:ay)?|cool|great|nice|got it|perfect|awesome|bye|goodbye|see you|stop|wait|yes|no|yep|nope)\b[\s,.!?]*(?:echo|so much|a lot)?[\s,.!?]*$/i

export function chooseModelTier(input: RouteInput): ModelRoute {
  const q = input.question.trim()
  const on = (r: QualityRoute): boolean => !input.routes || input.routes.has(r)
  const words = q.split(/\s+/).filter(Boolean).length

  // Whole kinds of turn that need the stronger model whatever their wording.
  if (input.lesson && on('lesson')) return { tier: 'strong', reasons: ['lesson'] }
  if (input.practice && on('practice')) return { tier: 'strong', reasons: ['practice'] }
  // Reading code, an error, a diagram or an equation off a screenshot is where the stronger model's vision pays off.
  if (input.screenShared && asksAboutScreen(q) && on('screen')) return { tier: 'strong', reasons: ['screen'] }

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
  // "What about that?" right after a hard answer continues it: switching to the fast model mid-thread loses depth.
  // A short question that doesn't point back at that answer ("what is my name?") isn't a follow-up.
  if (input.previousTier === 'strong' && words <= 12 && !PLEASANTRY.test(q) && CONTINUES.test(q) && on('follow-up')) {
    return { tier: 'strong', reasons: ['follow-up', ...reasons] }
  }
  // "Why?" or "Thanks, that's wrong" alone is too little to go on; a repair still counts.
  if (words < 4 && !reasons.includes('repair')) return { tier: 'fast', reasons: ['short'] }
  if (score >= 2 && on('reasoning')) return { tier: 'strong', reasons }
  return { tier: 'fast', reasons: reasons.length ? reasons : ['simple'] }
}

/** Reads ECHO_QUALITY_ROUTES ("all", "none", or a comma list of QUALITY_ROUTES). Unknown names are ignored. */
export function parseQualityRoutes(raw: string | undefined): Set<QualityRoute> {
  const v = raw?.trim().toLowerCase()
  if (!v || v === 'all') return new Set(QUALITY_ROUTES)
  if (v === 'none' || v === 'off') return new Set()
  return new Set(v.split(',').map((s) => s.trim()).filter((s): s is QualityRoute => (QUALITY_ROUTES as readonly string[]).includes(s)))
}
