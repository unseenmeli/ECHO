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
      'Save a lasting preference the learner explicitly asked you to keep ("remember that I prefer diagrams", "from now on be less formal", "call me Sam"). Replaces any earlier value for the key. Never use it for one-off requests such as "explain this briefly", and never for something you only inferred.',
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
- Call remember_preference only when the learner explicitly asks you to remember something or sets a standing rule: "remember that I prefer diagrams", "from now on, be less formal", "always keep it short", "call me Sam". Confirm aloud in one short sentence in the same reply.
- A request about the current answer is temporary. "Explain this briefly", "just this once", "for now", "quickly" are followed for this answer and never saved.
- If you notice a pattern the learner never asked you to keep (for example, they keep asking for shorter answers), you may ask once, briefly, whether you should remember it, and call propose_preference. Never use remember_preference for something you inferred, and don't ask again about a pattern they declined.
- Call forget_preference only when the learner asks you to forget, remove or reset something.
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
        if (!asksToRemember(utterance)) {
          // The model saved something the learner did not ask to keep. Do not write it.
          return { tool: call.name, note: 'ignored: the learner did not ask to remember this', changed: false }
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
