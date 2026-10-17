import { z } from 'zod'

// The visuals agent never writes Excalidraw JSON. It emits these semantic
// operations; our renderer turns them into laid-out, styled elements. They are
// validated before anything touches the board, and are treated purely as data.

export const COLORS = ['neutral', 'pink', 'blue', 'green', 'orange', 'red', 'purple'] as const
export const SIDES = ['right', 'left', 'above', 'below'] as const

/** Logical ids: short snake_case names the agent invents and reuses across the lesson. */
const Id = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,31}$/, 'ids are lowercase snake_case, at most 32 characters, starting with a letter')
const Label = z.string().min(1).max(48).describe('Short on-board label, ideally 1-4 words. No newlines.')
const Detail = z.string().max(80).describe('Optional second line under the label.')
const Color = z.enum(COLORS)

const NodeSpec = z.object({
  id: Id,
  label: Label,
  detail: Detail.optional(),
  color: Color.optional(),
  shape: z.enum(['box', 'round', 'diamond', 'pill']).optional()
})

const EdgeSpec = z.object({
  from: Id,
  to: Id,
  label: z.string().min(1).max(28).optional().describe('Short verb/relationship shown on the arrow.'),
  style: z.enum(['solid', 'dashed']).optional(),
  both: z.boolean().optional().describe('Arrowheads at both ends.')
})

const DiagramOp = z
  .object({
    op: z.literal('diagram'),
    id: Id.describe('New unique id for this diagram block.'),
    title: Label.optional(),
    layout: z
      .enum(['row', 'column', 'grid', 'cycle', 'hub', 'tree'])
      .describe('row/column: sequence; grid: set of peers; cycle: loop; hub: first node in the centre; tree: first node is the root.'),
    nodes: z.array(NodeSpec).min(1).max(9),
    edges: z.array(EdgeSpec).max(14).optional(),
    new_region: z.boolean().optional().describe('Place away from existing content (use when the topic changed).')
  })
  .describe('Create a new labelled diagram block with automatic layout.')

const AddOp = z
  .object({
    op: z.literal('add'),
    diagram: Id.optional().describe('Existing diagram id to extend.'),
    near: Id.optional().describe('Existing element id the new nodes should sit next to.'),
    side: z.enum(SIDES).optional(),
    nodes: z.array(NodeSpec).max(6).optional(),
    edges: z.array(EdgeSpec).max(8).optional()
  })
  .describe('Extend an existing diagram: add nodes and/or arrows without moving anything.')

const ChartOp = z
  .object({
    op: z.literal('chart'),
    id: Id,
    data: Id.describe('Id of a data series supplied in the context. You cannot provide numbers yourself.'),
    kind: z.enum(['bar', 'line']),
    title: Label.optional(),
    new_region: z.boolean().optional()
  })
  .describe('Plot a supplied data series with labelled axes and units.')

const TableOp = z
  .object({
    op: z.literal('table'),
    id: Id,
    title: Label.optional(),
    columns: z.array(z.string().min(1).max(24)).min(2).max(5),
    rows: z.array(z.array(z.string().max(60)).min(2).max(5)).min(1).max(6),
    new_region: z.boolean().optional()
  })
  .describe('A comparison table. Every row has one cell per column.')

const TimelineOp = z
  .object({
    op: z.literal('timeline'),
    id: Id,
    title: Label.optional(),
    events: z
      .array(z.object({ id: Id, label: Label, when: z.string().max(20).optional(), detail: Detail.optional() }))
      .min(2)
      .max(7),
    new_region: z.boolean().optional()
  })
  .describe('Ordered events along a line.')

export const CODE_LANGUAGES = ['python', 'javascript', 'typescript', 'java', 'c', 'cpp', 'csharp', 'go', 'rust', 'sql', 'html', 'css', 'bash', 'other'] as const
/** Languages the board can run in its sandbox (the card gets a Run button). */
export const RUNNABLE_LANGUAGES: readonly string[] = ['python', 'javascript']

const CodeOp = z
  .object({
    op: z.literal('code'),
    id: Id,
    title: Label.optional(),
    language: z.enum(CODE_LANGUAGES),
    lines: z
      .array(z.string().max(80).describe('One line of source, indentation included. No newlines.'))
      .min(1)
      .max(24)
      .describe('The code, one entry per line. Line n can be highlighted as "<id>__l<n>" (1-based).'),
    new_region: z.boolean().optional()
  })
  .describe('A code card with line numbers. Python and JavaScript cards get a Run button for the learner.')

const NoteOp = z
  .object({
    op: z.literal('note'),
    id: Id,
    text: z.string().min(1).max(140),
    near: Id.optional(),
    color: Color.optional()
  })
  .describe('A short callout, optionally placed next to an element.')

const HighlightOp = z
  .object({
    op: z.literal('highlight'),
    targets: z.array(z.string().min(1).max(64)).min(1).max(6).describe('Element ids from the board summary.'),
    dim_others: z.boolean().optional().describe('Fade the rest of that diagram to focus attention.')
  })
  .describe('Emphasise elements with a ring. Replaces any previous highlight.')

const UnhighlightOp = z.object({ op: z.literal('unhighlight') }).describe('Remove all highlights and dimming.')

const UpdateOp = z
  .object({
    op: z.literal('update'),
    id: Id,
    label: Label.optional(),
    detail: Detail.optional(),
    color: Color.optional()
  })
  .describe('Change the label/detail/colour of an element you created.')

const MoveOp = z
  .object({ op: z.literal('move'), id: Id, near: Id, side: z.enum(SIDES) })
  .describe('Reposition an element you created next to another.')

const GroupOp = z
  .object({ op: z.literal('group'), id: Id, members: z.array(Id).min(2).max(8), label: Label.optional() })
  .describe('Draw a labelled dashed boundary around related elements.')

const RemoveOp = z
  .object({ op: z.literal('remove'), ids: z.array(Id).min(1).max(8) })
  .describe('Delete elements YOU created. Never remove the user\'s drawings.')

const FocusOp = z
  .object({ op: z.literal('focus'), targets: z.array(z.string().min(1).max(64)).min(1).max(8) })
  .describe('Pan/zoom the view to these elements.')

export const VisualOpSchema = z.discriminatedUnion('op', [
  DiagramOp,
  AddOp,
  ChartOp,
  TableOp,
  TimelineOp,
  CodeOp,
  NoteOp,
  HighlightOp,
  UnhighlightOp,
  UpdateOp,
  MoveOp,
  GroupOp,
  RemoveOp,
  FocusOp
])

export type VisualOp = z.infer<typeof VisualOpSchema>
export type NodeSpecT = z.infer<typeof NodeSpec>
export type EdgeSpecT = z.infer<typeof EdgeSpec>

export const VisualPlanSchema = z.object({
  no_visual: z.boolean().optional().describe('True when this segment needs no drawing; leave setup and cues empty.'),
  setup: z
    .array(VisualOpSchema)
    .max(8)
    .describe('Drawn BEFORE the segment is spoken, so everything the narration will mention is already visible.'),
  cues: z
    .array(
      z.object({
        sentence: z.number().int().min(0).max(7).describe('0-based index of the narration sentence this applies at the start of.'),
        ops: z.array(VisualOpSchema).min(1).max(3)
      })
    )
    .max(6)
    .describe('Applied when the listener reaches that sentence: highlights, reveals, small additions.')
})

export type VisualPlan = z.infer<typeof VisualPlanSchema>

/** JSON Schema for the Anthropic tool, generated from the same zod definition (single source of truth). */
export function visualPlanJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(VisualPlanSchema, { target: 'draft-7' }) as Record<string, unknown>
  delete schema.$schema
  return schema
}
