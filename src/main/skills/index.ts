// Instruction packs ("skills") for the tutor: plain-text teaching guidance kept in skills/<name>/SKILL.md and
// added to the system prompt of the requests they apply to. They change what the one tutor model is told for a
// turn. They are not another agent, and nothing is trained.
//
// The files are bundled at build time (Vite `?raw` glob), so selecting skills never touches the disk during a
// turn and cannot delay or outlive a cancelled reply.

const FILES = import.meta.glob('../../../skills/*/SKILL.md', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>

export const SKILL_NAMES = ['visual-teaching', 'deep-explanation', 'check-understanding'] as const
export type SkillName = (typeof SKILL_NAMES)[number]

export interface Skill {
  name: SkillName
  /** When the skill applies (from the frontmatter). Sent with the instructions so the model knows why it's loaded. */
  description: string
  instructions: string
}

/** Reads `---\nname: …\ndescription: …\n---\n<instructions>`. Throws on anything malformed: a broken pack is a bug. */
export function parseSkill(path: string, text: string): Skill {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text)
  if (!m) throw new Error(`${path}: missing frontmatter`)
  const meta: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([a-z-]+):\s*(.+)$/.exec(line.trim())
    if (kv) meta[kv[1]] = kv[2].trim()
  }
  const dir = /skills\/([^/]+)\/SKILL\.md$/.exec(path)?.[1]
  if (!meta.name || meta.name !== dir) throw new Error(`${path}: name must match its folder`)
  if (!(SKILL_NAMES as readonly string[]).includes(meta.name)) throw new Error(`${path}: unknown skill "${meta.name}"`)
  if (!meta.description) throw new Error(`${path}: missing description`)
  const instructions = m[2].replace(/\r\n/g, '\n').trim()
  if (!instructions) throw new Error(`${path}: no instructions`)
  return { name: meta.name as SkillName, description: meta.description, instructions }
}

function loadAll(): Record<SkillName, Skill> {
  const out: Partial<Record<SkillName, Skill>> = {}
  for (const [path, text] of Object.entries(FILES)) {
    const skill = parseSkill(path, text)
    out[skill.name] = skill
  }
  for (const name of SKILL_NAMES) if (!out[name]) throw new Error(`skills/${name}/SKILL.md is missing`)
  return out as Record<SkillName, Skill>
}

export const SKILLS: Readonly<Record<SkillName, Skill>> = loadAll()

/** What is happening this turn, as far as choosing skills is concerned. */
export interface SkillSituation {
  /** The reply is taught on the open whiteboard (segment protocol). */
  whiteboard: boolean
  /** The learner asked for more depth. */
  deep: boolean
  /** A practice or checkpoint activity the learner asked for is running. */
  practice: boolean
}

export function selectSkills(s: SkillSituation): SkillName[] {
  const out: SkillName[] = []
  if (s.whiteboard) out.push('visual-teaching')
  if (s.deep) out.push('deep-explanation')
  if (s.practice) out.push('check-understanding')
  return out
}

/** The system-prompt section for the selected skills ('' when none). */
export function skillsPrompt(names: readonly SkillName[]): string {
  if (!names.length) return ''
  const blocks = names.map((n) => {
    const s = SKILLS[n]
    return `<skill name="${s.name}">\nApplies: ${s.description}\n\n${s.instructions}\n</skill>`
  })
  return `\n\nINSTRUCTION PACKS\nThe app loaded these packs for this turn because they apply to it. Follow them together with everything above. Where a pack sets a length or structure, it replaces the defaults. The output format and the drawing operations above never change.\n\n${blocks.join('\n\n')}`
}
