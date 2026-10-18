import { isPreferenceKey, PREFERENCE_DEFS, PREFERENCE_KEYS, type PreferenceKey } from '../../shared/preferences'
import type { ChatTool, ToolCall } from '../voice/ports'
import type { PreferenceStorePort } from './preferenceStore'

const keyList = PREFERENCE_DEFS.map((d) => `${d.key} (${d.options ? d.options.join(' | ') : `short text: ${d.hint}`})`).join('; ')

const valueProp = { type: 'string', description: 'The new value. For keys with a fixed set of values, use one of them exactly.' }
const keyProp = { type: 'string', enum: [...PREFERENCE_KEYS], description: `Which preference. Keys: ${keyList}.` }

export const PREFERENCE_TOOLS: ChatTool[] = [
  {
    name: 'remember_preference',
    description:
      'Save a lasting preference the learner explicitly asked you to keep ("remember that I prefer diagrams", "from now on be less formal"), or the learner\'s name as soon as they introduce themselves ("I\'m Sam", "my name is Sam", "call me Sam"), without asking first. Replaces any earlier value for the key. Never use it for one-off requests such as "explain this briefly", and never for something you only inferred.',
    input_schema: { type: 'object', properties: { key: keyProp, value: valueProp }, required: ['key', 'value'] }
  },
  {
    name: 'propose_preference',
    description:
      'Use when you noticed a pattern the learner never asked you to keep and you are asking them, out loud, whether to remember it. Nothing is saved unless they answer yes on their next turn.',
    input_schema: { type: 'object', properties: { key: keyProp, value: valueProp }, required: ['key', 'value'] }
  },
  {
    name: 'forget_preference',
    description: 'Forget one saved preference, or all of them with key "all". Only when the learner asks you to forget, remove or reset.',
    input_schema: {
      type: 'object',
      properties: { key: { type: 'string', enum: [...PREFERENCE_KEYS, 'all'], description: 'Which preference to forget, or "all".' } },
      required: ['key']
    }
  }
]

/** Appended to the system prompt whenever the preference tools are offered. */
export const PREFERENCE_TOOL_GUIDE = `REMEMBERING PREFERENCES

You can save lasting preferences about how to teach this learner. Saving is deliberate and rare.
- Call remember_preference only when the learner explicitly asks you to remember something or sets a standing rule: "remember that I prefer diagrams", "from now on, be less formal", "always keep it short", "call me Sam". Call it before you say anything about saving: the tool result says whether it was saved. Then confirm aloud in one short sentence, or, if it was not saved, ask whether to remember it.
- A request about the current answer is temporary. "Explain this briefly", "just this once", "for now", "quickly" are followed for this answer and never saved.
- If you notice a pattern the learner never asked you to keep (for example, they keep asking for shorter answers), you may ask once, briefly, whether you should remember it, and call propose_preference. Never use remember_preference for something you inferred, and don't ask again about a pattern they declined.
- Names are kept for good. When the learner introduces themselves ("I'm Sam", "my name is Sam", "call me Sam"), call remember_preference with userName right away, without asking, then greet them by name. Never save a name you only guessed, and never save ECHO as their name.
- Your own name is always ECHO and is not a preference: never save a name for yourself.
- Call forget_preference only when the learner asks you to forget, remove or reset something. Forgetting "everything" keeps the learner's name; it goes only when they ask you to forget their name.
- Only the listed keys exist. Never save transcripts, what was on screen, secrets, or facts that are not about how to teach this learner.
- The learner's current request always beats a saved preference.`

// --- What counts as asking ---------------------------------------------------------------------------
// The model decides what the learner meant; these checks are the safety net that keeps a misjudged call
// from changing what is stored. A save needs words in the learner's own turn that ask for permanence.

const PERSIST_CUE = new RegExp(
  [
    String.raw`\bremember\b`,
    String.raw`\bfrom now on\b`,
    String.raw`\bfrom here on\b`,
    String.raw`\bgoing forward\b`,
    String.raw`\bin (?:the )?future\b`,
    String.raw`\bnext time\b`,
    String.raw`\b(?:always|never)\b`,
    String.raw`\bevery (?:time|answer|explanation)\b`,
    String.raw`\bby default\b`,
    String.raw`\bpermanent(?:ly)?\b`,
    String.raw`\bkeep (?:it|them|this|that|using|being|your)\b`,
    String.raw`\bcall me\b`,
    String.raw`\bmy name is\b`,
    String.raw`\b(?:i|i'd|i would) (?:prefer|like you to|want you to|rather)\b`,
    String.raw`\bi (?:prefer|like it when|always want)\b`,
    String.raw`\b(?:change|switch|use)\b[^.?!]{0,30}\bvoice\b`
  ].join('|'),
  'i'
)

const TEMPORARY_CUE = /\b(?:this time|just (?:this|for) |for now|right now|for this (?:one|answer|question)|just once|once only|quickly)\b/i

/** Words that ask for a standing change. A one-off request ("explain this briefly") has none. */
export function asksToRemember(utterance: string): boolean {
  if (!PERSIST_CUE.test(utterance)) return false
  // "Just for now, I'd prefer it short" is scoped to the present unless it also says it should last.
  if (TEMPORARY_CUE.test(utterance) && !/\b(?:remember|from now on|always|never|going forward|by default|permanent)/i.test(utterance)) return false
  return true
}

const FORGET_CUE = /\b(?:forget|remove|delete|clear|reset|erase|wipe|stop remembering|(?:don'?t|do not) remember|unremember)\b/i

export function asksToForget(utterance: string): boolean {
  return FORGET_CUE.test(utterance)
}

// --- Introductions ---------------------------------------------------------------------------------
// Introducing yourself is asking to be remembered: the name is saved at once, and for good.

const INTRO_CUE = /\b(?:my name(?:'s| is)|name's|call me|i'm|i am|this is|it's)\b/i
/** Words that follow "my name is" / "call me" without being a name ("call me back", "my name is on it"). */
const NOT_A_NAME = new Set(
  'a an the not just back later on in at out up down when if by for to and but or so please now here there again sometime tomorrow echo'.split(' ')
)

/** True when the learner's words introduce them by this name (the model's userName save is then honored). */
export function introduces(utterance: string, name: string): boolean {
  const first = name.trim().split(/\s+/)[0]?.toLowerCase()
  if (!first || !INTRO_CUE.test(utterance)) return false
  const words: string[] = utterance.toLowerCase().match(/[\p{L}'-]+/gu) ?? []
  return words.includes(first)
}

/**
 * The name in a plain introduction ("my name is Sam", "call me Sam", "my name's Sam Lee"), or null. Only these
 * unmistakable forms: "I'm …" is left to the model, since "I'm tired" is not a name.
 */
export function introductionIn(utterance: string): string | null {
  const m = /\b(?:my name(?:'s| is)|(?:you can |please )?call me)\s+([\p{L}][\p{L}'-]*)(?:\s+([\p{Lu}][\p{L}'-]*))?/iu.exec(utterance)
  if (!m || NOT_A_NAME.has(m[1].toLowerCase())) return null
  const last = m[2] && !NOT_A_NAME.has(m[2].toLowerCase()) ? ` ${m[2]}` : ''
  return `${m[1][0].toUpperCase()}${m[1].slice(1)}${last}`
}

const YES = /^(?:(?:yes|yeah|yep|yup|sure|ok|okay|please|absolutely|definitely|go ahead|do it|sounds good|that works|that'?d be (?:great|good|nice)|why not)\b[\s,.!]*)+(?:please|do that|save it|remember (?:that|it))?[\s,.!]*$/i
const NO = /^(?:(?:no|nope|nah|not really|don'?t|do not|never mind|nevermind|no thanks|no thank you|skip it|not now)\b[\s,.!]*)+(?:thanks|thank you|please)?[\s,.!]*$/i

export type ProposalAnswer = { kind: 'confirmed'; key: PreferenceKey; spoken: string } | { kind: 'declined'; spoken: string }

interface Proposal {
  key: PreferenceKey
  value: string
}

export interface ToolOutcome {
  tool: string
  /** Why nothing changed, or what happened; for the log. Never contains the saved value's source text. */
  note: string
  changed: boolean
}

/**
 * Applies the model's preference tool calls to the store, and holds the one preference ECHO has asked
 * about and is waiting for a yes or no on.
 */
export class PreferenceTools {
  private proposal: Proposal | null = null

  constructor(private readonly store: PreferenceStorePort) {}

  reset(): void {
    this.proposal = null
  }

  /** `utterance` is what the learner just said: the call is only honored if their words back it up. */
  handle(call: ToolCall, utterance: string): ToolOutcome {
    const input = (call.input ?? {}) as Record<string, unknown>
    switch (call.name) {
      case 'remember_preference': {
        if (!isPreferenceKey(input.key)) return { tool: call.name, note: 'unknown key', changed: false }
        const introduced = input.key === 'userName' && typeof input.value === 'string' && introduces(utterance, input.value)
        if (!introduced && !asksToRemember(utterance)) {
          // The model saved something the learner did not ask to keep. Do not write it, but let a yes keep it,
          // unless they said it was only for now.
          if (TEMPORARY_CUE.test(utterance)) {
            return { tool: call.name, note: 'not saved: the learner asked for this only for now. Do not say it was saved', changed: false }
          }
          this.proposal = { key: input.key, value: typeof input.value === 'string' ? input.value : '' }
          return {
            tool: call.name,
            note: 'not saved: the learner did not ask for this to last. Ask in one short question whether to remember it; it is saved only if they say yes',
            changed: false
          }
        }
        const r = this.store.set(input.key, input.value, 'explicit')
        this.proposal = null
        return r.ok ? { tool: call.name, note: `saved ${input.key}`, changed: r.changed } : { tool: call.name, note: `rejected: ${r.reason}`, changed: false }
      }
      case 'propose_preference': {
        if (!isPreferenceKey(input.key)) return { tool: call.name, note: 'unknown key', changed: false }
        const probe = this.store.get(input.key) // already saved as proposed: nothing to ask
        const value = typeof input.value === 'string' ? input.value : ''
        if (probe !== undefined && probe.toLowerCase() === value.trim().toLowerCase()) return { tool: call.name, note: 'already saved', changed: false }
        this.proposal = { key: input.key, value }
        return { tool: call.name, note: `waiting for a yes on ${input.key}`, changed: false }
      }
      case 'forget_preference': {
        if (!asksToForget(utterance)) return { tool: call.name, note: 'ignored: the learner did not ask to forget', changed: false }
        if (input.key === 'all') return { tool: call.name, note: 'forgot all', changed: this.store.forgetAll() > 0 }
        if (!isPreferenceKey(input.key)) return { tool: call.name, note: 'unknown key', changed: false }
        return { tool: call.name, note: `forgot ${input.key}`, changed: this.store.forget(input.key) }
      }
      default:
        return { tool: call.name, note: 'unknown tool', changed: false }
    }
  }

  /**
   * Called with every finished learner turn. If ECHO asked to remember something, a short yes saves it and a
   * short no drops it; anything else drops the question and is handled as an ordinary turn (returns null).
   */
  resolveProposal(transcript: string): ProposalAnswer | null {
    const p = this.proposal
    if (!p) return null
    this.proposal = null
    const text = transcript.trim().replace(/\s+/g, ' ')
    if (text.split(' ').length > 8) return null
    if (YES.test(text)) {
      const r = this.store.set(p.key, p.value, 'confirmed')
      return r.ok ? { kind: 'confirmed', key: p.key, spoken: "Got it, I'll remember that." } : null
    }
    if (NO.test(text)) return { kind: 'declined', spoken: "Okay, I won't save that." }
    return null
  }
}
