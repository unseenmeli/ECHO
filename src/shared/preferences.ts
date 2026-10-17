// Contracts for ECHO's saved user preferences. Shared by the main process (which owns the store and the
// agent tools that write to it) and the UI windows (which list, edit and forget entries).
//
// Preferences are a small, fixed set of keys with validated values. They describe how to teach this
// learner. They are never an archive of what was said.

export const PREFERENCE_KEYS = [
  'explanationDepth',
  'pace',
  'visualStyle',
  'personality',
  'humor',
  'talkativeness',
  'proactivity',
  'voice',
  'language',
  'userName'
] as const

export type PreferenceKey = (typeof PREFERENCE_KEYS)[number]

/** Where a saved value came from. Inferred guesses never reach the store without a "yes" (`confirmed`). */
export type PreferenceSource = 'explicit' | 'confirmed' | 'user'

export interface PreferenceEntry {
  value: string
  updatedAt: number
  source: PreferenceSource
}

export type PreferenceMap = Partial<Record<PreferenceKey, PreferenceEntry>>

/** Deepgram Aura-2 voices ECHO can speak with (the first is the app default). */
export const VOICES = [
  'aura-2-thalia-en',
  'aura-2-helena-en',
  'aura-2-apollo-en',
  'aura-2-aries-en',
  'aura-2-andromeda-en',
  'aura-2-athena-en',
  'aura-2-luna-en',
  'aura-2-orion-en',
  'aura-2-arcas-en',
  'aura-2-zeus-en'
] as const

export interface PreferenceDef {
  key: PreferenceKey
  label: string
  /** One line for the settings window and for the agent's tool description. */
  hint: string
  /** Closed set of values; absent for short free text. */
  options?: readonly string[]
  maxLength: number
}

export const PREFERENCE_DEFS: readonly PreferenceDef[] = [
  { key: 'explanationDepth', label: 'Explanation depth', hint: 'How much detail answers go into by default.', options: ['brief', 'balanced', 'thorough'], maxLength: 12 },
  { key: 'pace', label: 'Pace', hint: 'How fast ECHO moves through an explanation.', options: ['slow', 'moderate', 'fast'], maxLength: 12 },
  { key: 'visualStyle', label: 'Visual style', hint: 'What the whiteboard should look like, e.g. "diagrams", "minimal sketches".', maxLength: 60 },
  { key: 'personality', label: 'Personality', hint: "ECHO's tone, e.g. \"casual and encouraging\", \"less formal\".", maxLength: 80 },
  { key: 'humor', label: 'Humor', hint: 'How much ECHO jokes around.', options: ['none', 'light', 'playful'], maxLength: 12 },
  { key: 'talkativeness', label: 'Talkativeness', hint: 'How much ECHO says beyond the answer.', options: ['concise', 'balanced', 'chatty'], maxLength: 12 },
  { key: 'proactivity', label: 'Proactivity', hint: 'Whether ECHO offers next steps and checks understanding on its own.', options: ['reactive', 'balanced', 'proactive'], maxLength: 12 },
  { key: 'voice', label: 'Voice', hint: "ECHO's speaking voice. Applies from the next reply.", options: VOICES, maxLength: 30 },
  { key: 'language', label: 'Language', hint: 'The language ECHO answers in.', maxLength: 30 },
  { key: 'userName', label: 'Your name', hint: 'What ECHO calls you.', maxLength: 40 }
]

const DEF_BY_KEY = new Map<string, PreferenceDef>(PREFERENCE_DEFS.map((d) => [d.key, d]))

export function isPreferenceKey(key: unknown): key is PreferenceKey {
  return typeof key === 'string' && DEF_BY_KEY.has(key)
}

export function preferenceDef(key: PreferenceKey): PreferenceDef {
  return DEF_BY_KEY.get(key)!
}

// Things that must never be written to disk or into a prompt: credentials, payment and identity numbers,
// contact details. Preference values are short and about teaching, so refusing is always safe.
const SENSITIVE: RegExp[] = [
  /\b(?:sk|pk|rk|xox[bap]|ghp|gho|AKIA)[-_][A-Za-z0-9_-]{8,}/i,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/i,
  /[A-Za-z0-9+/_=-]{32,}/,
  /\b(?:api[\s_-]?key|secret|passw(?:or)?d|passcode|pin code|token|credential|private key|ssh key)s?\b/i,
  /\b(?:\d[ -]?){13,19}\b/,
  /\b\d{3}-\d{2}-\d{4}\b/,
  /[\w.+-]+@[\w-]+\.[\w.-]+/
]

export function looksSensitive(text: string): boolean {
  return SENSITIVE.some((re) => re.test(text))
}

export type Validated = { ok: true; value: string } | { ok: false; reason: string }

/** Normalizes and checks a value for `key`. Used for every write, whoever asks (agent, settings window, disk). */
export function validatePreference(key: PreferenceKey, raw: unknown): Validated {
  if (typeof raw !== 'string') return { ok: false, reason: 'The value must be text.' }
  const def = preferenceDef(key)
  // Values are quoted into the system prompt: no line breaks, no angle brackets that could fake a tag.
  const value = raw
    .replace(/[\u0000-\u001f\u007f<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!value) return { ok: false, reason: 'The value is empty.' }
  if (def.options) {
    const match = def.options.find((o) => o.toLowerCase() === value.toLowerCase())
    return match ? { ok: true, value: match } : { ok: false, reason: `${def.label} must be one of: ${def.options.join(', ')}.` }
  }
  if (value.length > def.maxLength) return { ok: false, reason: `${def.label} must be at most ${def.maxLength} characters.` }
  if (looksSensitive(value)) return { ok: false, reason: 'That looks like sensitive information, so it was not saved.' }
  return { ok: true, value }
}

// --- View sent to the UI windows ----------------------------------------------------------------

export interface PreferenceRow {
  key: PreferenceKey
  label: string
  hint: string
  options?: readonly string[]
  maxLength: number
  entry: PreferenceEntry | null
}

export interface PreferencesView {
  rows: PreferenceRow[]
}

/** "Preference saved · Undo". `id` ties an Undo click to the change it announced. */
export interface PreferenceToast {
  id: number
  message: string
}

export type PreferenceEvent = { type: 'changed'; view: PreferencesView } | { type: 'toast'; toast: PreferenceToast | null }

export type PreferenceCommand =
  | { type: 'set'; key: PreferenceKey; value: string }
  | { type: 'forget'; key: PreferenceKey }
  | { type: 'forget-all' }
  | { type: 'undo'; id: number }

/** `reason` says why a command was refused, in words fit to show the learner. */
export type PreferenceCommandResult = { ok: true } | { ok: false; reason: string }

/** Runtime validation for commands arriving over IPC. */
export function parsePreferenceCommand(raw: unknown): PreferenceCommand | null {
  if (!raw || typeof raw !== 'object') return null
  const c = raw as Record<string, unknown>
  switch (c.type) {
    case 'set':
      return isPreferenceKey(c.key) && typeof c.value === 'string' ? { type: 'set', key: c.key, value: c.value } : null
    case 'forget':
      return isPreferenceKey(c.key) ? { type: 'forget', key: c.key } : null
    case 'forget-all':
      return { type: 'forget-all' }
    case 'undo':
      return typeof c.id === 'number' && Number.isInteger(c.id) ? { type: 'undo', id: c.id } : null
    default:
      return null
  }
}
